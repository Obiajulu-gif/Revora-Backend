import assert from 'assert';
import { createRegisterHandler } from './registerHandler';
import { RegisterService, DuplicateEmailError } from './registerService';
import { RegisteredUser } from './types';
import { AppError, ErrorCode, UniqueConstraintError } from '../../lib/errors';

// ─── Mock RegisterService ─────────────────────────────────────────────────────

class MockRegisterService {
  result: RegisteredUser | null = null;
  shouldThrow: unknown = null;

  async register(_email: string, _password: string): Promise<RegisteredUser> {
    if (this.shouldThrow) throw this.shouldThrow;
    return this.result!;
  }
}

// ─── Request / Response helpers ───────────────────────────────────────────────

function makeReq(body: unknown = {}) {
  return { body } as any;
}

function makeRes() {
  let statusCode = 200;
  let jsonData: unknown = null;
  return {
    status(code: number) { statusCode = code; return this; },
    json(obj: unknown) { jsonData = obj; return this; },
    _get() { return { statusCode, jsonData }; },
  } as any;
}

function makeUser(overrides: Partial<RegisteredUser> = {}): RegisteredUser {
  return {
    id: 'user-1',
    email: 'investor@example.com',
    role: 'investor',
    created_at: new Date('2024-01-01'),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('registerHandler', () => {
  it('covers registration handler behaviors', async () => {
  // ── 201 on success ─────────────────────────────────────────────────────────
  {
    const svc = new MockRegisterService();
    svc.result = makeUser();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    await handler(makeReq({ email: 'investor@example.com', password: 'StrongSecret123!' }), res, (e: unknown) => { if (e) throw e; });
    const { statusCode, jsonData } = res._get();
    assert.strictEqual(statusCode, 201, `expected 201 got ${statusCode}`);
    assert.deepStrictEqual((jsonData as any).user, { id: 'user-1', email: 'investor@example.com', role: 'investor' });
  }

  // ── name is accepted (and silently ignored) ────────────────────────────────
  {
    const svc = new MockRegisterService();
    svc.result = makeUser({ email: 'alice@example.com' });
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    await handler(makeReq({ email: 'alice@example.com', password: 'StrongPass555!', name: 'Alice' }), res, (e: unknown) => { if (e) throw e; });
    assert.strictEqual(res._get().statusCode, 201);
  }

  // ── 400 when email is missing ──────────────────────────────────────────────
  {
    const svc = new MockRegisterService();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    let capturedErr: any = null;
    await handler(makeReq({ password: 'password1' }), res, (e: unknown) => { capturedErr = e; });
    assert(capturedErr instanceof AppError);
    assert.strictEqual(capturedErr.statusCode, 400);
    assert.strictEqual(capturedErr.code, ErrorCode.BAD_REQUEST);
  }

  // ── 400 when password is missing ──────────────────────────────────────────
  {
    const svc = new MockRegisterService();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    let capturedErr: any = null;
    await handler(makeReq({ email: 'investor@example.com' }), res, (e: unknown) => { capturedErr = e; });
    assert(capturedErr instanceof AppError);
    assert.strictEqual(capturedErr.statusCode, 400);
  }

  // ── 400 when body is entirely absent ──────────────────────────────────────
  {
    const svc = new MockRegisterService();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    let capturedErr: any = null;
    await handler(makeReq(undefined), res, (e: unknown) => { capturedErr = e; });
    assert(capturedErr instanceof AppError);
    assert.strictEqual(capturedErr.statusCode, 400);
  }

  // ── 400 when email is not a string ────────────────────────────────────────
  {
    const svc = new MockRegisterService();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    let capturedErr: any = null;
    await handler(makeReq({ email: 123, password: 'password1' }), res, (e: unknown) => { capturedErr = e; });
    assert(capturedErr instanceof AppError);
    assert.strictEqual(capturedErr.statusCode, 400);
  }

  // ── 400 for invalid email format (no @) ───────────────────────────────────
  {
    const svc = new MockRegisterService();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    let capturedErr: any = null;
    await handler(makeReq({ email: 'notanemail', password: 'password1' }), res, (e: unknown) => { capturedErr = e; });
    assert(capturedErr instanceof AppError);
    assert.strictEqual(capturedErr.statusCode, 400);
    assert.match(capturedErr.message, /email/i);
  }

  // ── Password strength validation (forwarded from service) ──────────────────
  {
    const svc = new MockRegisterService();
    const err = new AppError(ErrorCode.VALIDATION_ERROR, 'Weak password', 400);
    svc.shouldThrow = err;
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    let capturedErr: any = null;
    await handler(makeReq({ email: 'investor@example.com', password: 'short' }), res, (e: unknown) => { capturedErr = e; });
    assert.strictEqual(capturedErr, err);
  }

  // ── 409 when service throws DuplicateEmailError ────────────────────────────
  {
    const svc = new MockRegisterService();
    svc.shouldThrow = new DuplicateEmailError();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    let capturedErr: any = null;
    await handler(makeReq({ email: 'taken@example.com', password: 'StrongPass666!' }), res, (e: unknown) => { capturedErr = e; });
    assert(capturedErr instanceof AppError);
    assert.strictEqual(capturedErr.statusCode, 409);
    assert.strictEqual(capturedErr.code, ErrorCode.CONFLICT);
    assert.strictEqual(capturedErr.message, 'Email already registered');
  }

  // ── 409 when service throws UniqueConstraintError ────────────────────────────
  {
    const svc = new MockRegisterService();
    svc.shouldThrow = new UniqueConstraintError('email');
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    let capturedErr: any = null;
    await handler(makeReq({ email: 'taken@example.com', password: 'StrongPass666!' }), res, (e: unknown) => { capturedErr = e; });
    assert(capturedErr instanceof AppError);
    assert.strictEqual(capturedErr.statusCode, 409);
    assert.strictEqual(capturedErr.code, ErrorCode.CONFLICT);
  }

  // ── Unexpected errors are forwarded to next() ─────────────────────────────
  {
    const svc = new MockRegisterService();
    svc.shouldThrow = new Error('unexpected DB failure');
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    let capturedErr: unknown = null;
    const res = makeRes();
    await handler(makeReq({ email: 'investor@example.com', password: 'StrongPass777!' }), res, (e: unknown) => { capturedErr = e; });
    assert(capturedErr instanceof Error && capturedErr.message === 'unexpected DB failure');
  }
  });
});

