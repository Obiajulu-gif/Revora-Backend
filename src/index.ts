import "dotenv/config";
import express, { Request, Response } from "express";
import morgan from "morgan";
import { dbHealth, closePool } from "./db/client";
import { createCorsMiddleware } from "./middleware/cors";
import {
  createMilestoneValidationRouter,
  DomainEventPublisher,
  Milestone,
  MilestoneRepository,
  MilestoneValidationEvent,
  MilestoneValidationEventRepository,
  VerifierAssignmentRepository,
} from "./vaults/milestoneValidationRoute";

const app = express();
const port = process.env.PORT ?? 3000;
/**
 * @dev The global prefix applied to all business logic routers.
 * Defaults to `/api/v1` if `process.env.API_VERSION_PREFIX` is not supplied.
 * Crucial for preventing route conflict and ensuring reliable downstream tooling (e.g. AWS API Gateway handling).
 */
const API_VERSION_PREFIX = process.env.API_VERSION_PREFIX ?? '/api/v1';
const apiRouter = express.Router();

type DomainEventPayload = Record<string, unknown>;

interface ReliablePublisherConfig {
  maxAttempts: number;
  retryBaseMs: number;
  queueCapacity: number;
  deadLetterCapacity: number;
  dedupeTtlMs: number;
}

interface QueuedDomainEvent {
  id: string;
  idempotencyKey: string;
  eventName: string;
  payload: DomainEventPayload;
  attempts: number;
  nextAttemptAtMs: number;
  createdAt: Date;
  lastError: string | null;
}

interface DeadLetterDomainEvent extends QueuedDomainEvent {
  deadLetteredAt: Date;
}

interface EventPublisherHealthSnapshot {
  queued: number;
  inFlight: boolean;
  deadLetterCount: number;
  lastPublishedAt: string | null;
  lastError: string | null;
  maxAttempts: number;
  retryBaseMs: number;
  queueCapacity: number;
}

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
};

const stableSerialize = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const serialized = keys
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(obj[key])}`)
    .join(",");
  return `{${serialized}}`;
};

/**
 * @notice Reliability wrapper around domain-event publishing.
 * @dev Provides in-memory queueing, bounded retries with backoff, idempotent acceptance,
 * and dead-letter capture to avoid silent data-loss on transient transport failures.
 * @security This is intentionally fail-soft for business continuity:
 * state transition succeeds once the event is accepted into this process-local queue.
 */
class ReliableMilestoneEventPublisher implements DomainEventPublisher {
  private readonly queue: QueuedDomainEvent[] = [];
  private readonly deadLetter: DeadLetterDomainEvent[] = [];
  private readonly dedupeUntilByKey = new Map<string, number>();
  private processing = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private counter = 0;
  private lastPublishedAt: Date | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly transport: DomainEventPublisher,
    private readonly config: ReliablePublisherConfig,
  ) {}

  async publish(eventName: string, payload: DomainEventPayload): Promise<void> {
    if (!/^[a-z0-9][a-z0-9._-]{2,127}$/i.test(eventName)) {
      throw new Error("Invalid domain event name format");
    }

    if (!payload || Array.isArray(payload) || typeof payload !== "object") {
      throw new Error("Domain event payload must be a non-array object");
    }

    this.pruneExpiredDedupe();
    const idempotencyKey = this.deriveIdempotencyKey(eventName, payload);

    const seenUntil = this.dedupeUntilByKey.get(idempotencyKey);
    if (seenUntil && seenUntil > Date.now()) {
      return;
    }

    if (this.queue.some((queuedEvent) => queuedEvent.idempotencyKey === idempotencyKey)) {
      return;
    }

    if (this.deadLetter.some((deadLetterEvent) => deadLetterEvent.idempotencyKey === idempotencyKey)) {
      return;
    }

    const event: QueuedDomainEvent = {
      id: `domain-event-${++this.counter}`,
      idempotencyKey,
      eventName,
      payload: { ...payload },
      attempts: 0,
      nextAttemptAtMs: Date.now(),
      createdAt: new Date(),
      lastError: null,
    };

    if (this.queue.length >= this.config.queueCapacity) {
      this.moveToDeadLetter(event, "queue_capacity_exceeded");
      return;
    }

    this.queue.push(event);
    void this.processQueue();
  }

  getHealthSnapshot(): EventPublisherHealthSnapshot {
    return {
      queued: this.queue.length,
      inFlight: this.processing,
      deadLetterCount: this.deadLetter.length,
      lastPublishedAt: this.lastPublishedAt ? this.lastPublishedAt.toISOString() : null,
      lastError: this.lastError,
      maxAttempts: this.config.maxAttempts,
      retryBaseMs: this.config.retryBaseMs,
      queueCapacity: this.config.queueCapacity,
    };
  }

  isHealthy(): boolean {
    return this.deadLetter.length === 0;
  }

  async shutdown(): Promise<void> {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    await this.processQueue();
  }

  private deriveIdempotencyKey(eventName: string, payload: DomainEventPayload): string {
    const payloadWithIdentity = payload.validationEventId
      ? { validationEventId: payload.validationEventId }
      : payload;
    return `${eventName}:${stableSerialize(payloadWithIdentity)}`;
  }

  private async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }

    try {
      while (true) {
        this.pruneExpiredDedupe();
        const nowMs = Date.now();
        const dueIndex = this.queue.findIndex((event) => event.nextAttemptAtMs <= nowMs);

        if (dueIndex < 0) {
          this.scheduleNextRetry();
          break;
        }

        const event = this.queue[dueIndex];
        event.attempts += 1;

        try {
          await this.transport.publish(event.eventName, event.payload);
          this.queue.splice(dueIndex, 1);
          this.dedupeUntilByKey.set(
            event.idempotencyKey,
            Date.now() + this.config.dedupeTtlMs,
          );
          this.lastPublishedAt = new Date();
          this.lastError = null;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "unknown_publish_error";
          this.lastError = errorMessage;
          event.lastError = errorMessage;

          if (event.attempts >= this.config.maxAttempts) {
            this.queue.splice(dueIndex, 1);
            this.moveToDeadLetter(event, errorMessage);
            continue;
          }

          const retryDelayMs = Math.min(
            30_000,
            this.config.retryBaseMs * 2 ** (event.attempts - 1),
          );
          event.nextAttemptAtMs = Date.now() + retryDelayMs;
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private scheduleNextRetry(): void {
    if (this.retryTimer || this.queue.length === 0) {
      return;
    }

    const nextDueAtMs = this.queue.reduce(
      (min, item) => Math.min(min, item.nextAttemptAtMs),
      Number.MAX_SAFE_INTEGER,
    );
    const delayMs = Math.max(0, nextDueAtMs - Date.now());

    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.processQueue();
    }, delayMs);
  }

  private moveToDeadLetter(event: QueuedDomainEvent, reason: string): void {
    const deadLetterEvent: DeadLetterDomainEvent = {
      ...event,
      lastError: reason,
      deadLetteredAt: new Date(),
    };

    this.deadLetter.push(deadLetterEvent);
    if (this.deadLetter.length > this.config.deadLetterCapacity) {
      this.deadLetter.shift();
    }

    // eslint-disable-next-line no-console
    console.error(
      `[domain-event][dead-letter] ${event.eventName} id=${event.id} reason=${reason}`,
    );
  }

  private pruneExpiredDedupe(): void {
    const nowMs = Date.now();
    for (const [key, validUntil] of this.dedupeUntilByKey.entries()) {
      if (validUntil <= nowMs) {
        this.dedupeUntilByKey.delete(key);
      }
    }
  }
}

const createReliableMilestoneEventPublisher = (
  transport: DomainEventPublisher,
  overrides: Partial<ReliablePublisherConfig> = {},
): ReliableMilestoneEventPublisher => {
  return new ReliableMilestoneEventPublisher(transport, {
    maxAttempts: 3,
    retryBaseMs: 5,
    queueCapacity: 10,
    deadLetterCapacity: 10,
    dedupeTtlMs: 60_000,
    ...overrides,
  });
};

export const __test = {
  parsePositiveInt,
  stableSerialize,
  createReliableMilestoneEventPublisher,
};

class InMemoryMilestoneRepository implements MilestoneRepository {
  constructor(private readonly milestones = new Map<string, Milestone>()) {}

  private key(vaultId: string, milestoneId: string): string {
    return `${vaultId}:${milestoneId}`;
  }

  async getByVaultAndId(
    vaultId: string,
    milestoneId: string,
  ): Promise<Milestone | null> {
    return this.milestones.get(this.key(vaultId, milestoneId)) ?? null;
  }

  async markValidated(input: {
    vaultId: string;
    milestoneId: string;
    verifierId: string;
    validatedAt: Date;
  }): Promise<Milestone> {
    const key = this.key(input.vaultId, input.milestoneId);
    const current = this.milestones.get(key);

    /* istanbul ignore next -- guarded by pre-check in validate handler */
    if (!current) {
      throw new Error("Milestone not found");
    }

    const updated: Milestone = {
      ...current,
      status: "validated",
      validated_by: input.verifierId,
      validated_at: input.validatedAt,
    };
    this.milestones.set(key, updated);
    return updated;
  }
}

class InMemoryVerifierAssignmentRepository implements VerifierAssignmentRepository {
  constructor(private readonly assignments = new Map<string, Set<string>>()) {}

  async isVerifierAssignedToVault(
    vaultId: string,
    verifierId: string,
  ): Promise<boolean> {
    return this.assignments.get(vaultId)?.has(verifierId) ?? false;
  }
}

class InMemoryMilestoneValidationEventRepository implements MilestoneValidationEventRepository {
  private events: MilestoneValidationEvent[] = [];
  private counter = 0;

  async create(input: {
    vaultId: string;
    milestoneId: string;
    verifierId: string;
    createdAt: Date;
  }): Promise<MilestoneValidationEvent> {
    this.counter += 1;
    const event: MilestoneValidationEvent = {
      id: `validation-event-${this.counter}`,
      vault_id: input.vaultId,
      milestone_id: input.milestoneId,
      verifier_id: input.verifierId,
      created_at: input.createdAt,
    };
    this.events.push(event);
    return event;
  }
}

class ConsoleDomainEventPublisher implements DomainEventPublisher {
  async publish(
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[domain-event] ${eventName}`, payload);
  }
}

const requireAuth = (req: Request, res: Response, next: () => void): void => {
  const userId = req.header("x-user-id");
  const role = req.header("x-user-role");

  if (!userId || !role) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  (req as any).user = {
    id: userId,
    role,
  };

  next();
};

const milestoneRepository = new InMemoryMilestoneRepository(
  new Map<string, Milestone>([
    [
      "vault-1:milestone-1",
      {
        id: "milestone-1",
        vault_id: "vault-1",
        status: "pending",
      },
    ],
    [
      "vault-1:milestone-2",
      {
        id: "milestone-2",
        vault_id: "vault-1",
        status: "pending",
      },
    ],
    [
      "vault-1:milestone-3",
      {
        id: "milestone-3",
        vault_id: "vault-1",
        status: "pending",
      },
    ],
  ]),
);
const verifierAssignmentRepository = new InMemoryVerifierAssignmentRepository(
  new Map<string, Set<string>>([["vault-1", new Set(["verifier-1"])]]),
);
const milestoneValidationEventRepository =
  new InMemoryMilestoneValidationEventRepository();
const domainEventPublisher = new ReliableMilestoneEventPublisher(
  new ConsoleDomainEventPublisher(),
  {
    maxAttempts: parsePositiveInt(
      process.env.MILESTONE_EVENT_PUBLISH_MAX_ATTEMPTS,
      process.env.NODE_ENV === "test" ? 3 : 6,
    ),
    retryBaseMs: parsePositiveInt(
      process.env.MILESTONE_EVENT_PUBLISH_RETRY_BASE_MS,
      process.env.NODE_ENV === "test" ? 5 : 250,
    ),
    queueCapacity: parsePositiveInt(
      process.env.MILESTONE_EVENT_PUBLISH_QUEUE_CAPACITY,
      2_000,
    ),
    deadLetterCapacity: parsePositiveInt(
      process.env.MILESTONE_EVENT_PUBLISH_DEAD_LETTER_CAPACITY,
      500,
    ),
    dedupeTtlMs: parsePositiveInt(
      process.env.MILESTONE_EVENT_PUBLISH_DEDUPE_TTL_MS,
      5 * 60 * 1000,
    ),
  },
);

app.use(createCorsMiddleware());
app.use(express.json());
app.use(morgan("dev"));
/**
 * @dev All API business routes are deliberately scoped under the target version prefix.
 * This establishes an enforced boundary constraint preventing un-versioned fallback leaks.
 */
app.use(API_VERSION_PREFIX, apiRouter);

apiRouter.use(
  createMilestoneValidationRouter({
    requireAuth,
    milestoneRepository,
    verifierAssignmentRepository,
    milestoneValidationEventRepository,
    domainEventPublisher,
  }),
);

/**
 * @notice Operational route explicitly bypassing the API prefix boundary.
 * @dev Used generically by load balancers and orchestrators without coupling them to specific versions.
 */
app.get("/health", async (_req: Request, res: Response) => {
  const db = await dbHealth();
  const events = domainEventPublisher.getHealthSnapshot();
  const healthy = db.healthy && domainEventPublisher.isHealthy();

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    service: "revora-backend",
    db,
    events,
  });
});

apiRouter.get('/overview', (_req: Request, res: Response) => {
  res.json({
    name: "Stellar RevenueShare (Revora) Backend",
    description:
      "Backend API skeleton for tokenized revenue-sharing on Stellar (offerings, investments, revenue distribution).",
  });
});

/* istanbul ignore next -- signal-driven lifecycle path */
const shutdown = async (signal: string) => {
  console.log(`\n[server] ${signal} DB shutting down…`);
  await domainEventPublisher.shutdown();
  await closePool();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

/* istanbul ignore next -- server listener is disabled in tests */
if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`revora-backend listening on http://localhost:${port}`);
  });
}

export default app;
