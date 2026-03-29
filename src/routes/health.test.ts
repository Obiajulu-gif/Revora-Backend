import request from 'supertest';
import app, {
  __test,
  classifyStellarRPCFailure,
  StellarRPCFailureClass,
} from '../index';
import { closePool } from '../db/client';
import { ErrorCode } from '../lib/errors';
import { mapHealthDependencyFailure } from './health';
import { StellarSubmissionService } from '../services/stellarSubmissionService';

jest.mock('../services/stellarSubmissionService', () => ({
  StellarSubmissionService: jest.fn().mockImplementation(() => ({
    submitPayment: jest.fn().mockResolvedValue({ hash: 'tx-mock-1', status: 'SUCCESS' }),
  })),
}));

const mockedStellarSubmissionService =
  StellarSubmissionService as unknown as jest.MockedClass<typeof StellarSubmissionService>;
let submitPaymentMock: jest.Mock;

function submissionPath(): string {
  const prefix = process.env.API_VERSION_PREFIX ?? '/api/v1';
  return `${prefix}/stellar/submit-payment`;
}

function authHeaders(idempotencyKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'x-user-id': 'user-1',
    'x-user-role': 'investor',
  };

  if (idempotencyKey) {
    headers['idempotency-key'] = idempotencyKey;
  }

  return headers;
}

afterAll(async () => {
  await closePool();
});

describe('classifyStellarRPCFailure', () => {
  it('classifies timeout failures', () => {
    const error = new Error('network timeout');
    error.name = 'AbortError';

    expect(classifyStellarRPCFailure(error)).toBe(StellarRPCFailureClass.TIMEOUT);
  });

  it('classifies rate limits from upstream status', () => {
    expect(classifyStellarRPCFailure({ status: 429 })).toBe(
      StellarRPCFailureClass.RATE_LIMIT,
    );
  });

  it('classifies malformed responses', () => {
    expect(classifyStellarRPCFailure(new SyntaxError('unexpected token'))).toBe(
      StellarRPCFailureClass.MALFORMED_RESPONSE,
    );
  });
});

describe('mapHealthDependencyFailure', () => {
  it('sanitizes database failures', () => {
    const mapped = mapHealthDependencyFailure('database', new Error('password auth failed'));

    expect(mapped.toResponse()).toEqual({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: 'Dependency unavailable',
      details: {
        dependency: 'database',
      },
    });
  });

  it('includes failure class for stellar failures', () => {
    const mapped = mapHealthDependencyFailure('stellar-horizon', { status: 503 });

    expect(mapped.toResponse()).toEqual({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: 'Dependency unavailable',
      details: {
        dependency: 'stellar-horizon',
        failureClass: StellarRPCFailureClass.UPSTREAM_ERROR,
        upstreamStatus: 503,
      },
    });
  });
});

describe('Stellar submission idempotency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __test.resetStellarSubmissionService();
    submitPaymentMock = jest
      .fn()
      .mockResolvedValue({ hash: 'tx-mock-1', status: 'SUCCESS' });
    mockedStellarSubmissionService.mockImplementation(
      () => ({ submitPayment: submitPaymentMock }) as unknown as StellarSubmissionService,
    );
  });

  it('requires authentication boundary headers', async () => {
    const response = await request(app)
      .post(submissionPath())
      .set('idempotency-key', 'stellar-no-auth-1')
      .send({
        destination: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        amount: '1.2500000',
      });

    expect(response.status).toBe(401);
  });

  it('requires an idempotency key', async () => {
    const response = await request(app)
      .post(submissionPath())
      .set(authHeaders())
      .send({
        destination: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        amount: '1.2500000',
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: ErrorCode.BAD_REQUEST,
      message: 'Idempotency-Key header is required',
    });
  });

  it('rejects invalid payload deterministically', async () => {
    const response = await request(app)
      .post(submissionPath())
      .set(authHeaders('stellar-invalid-payload-1'))
      .send({
        destination: 'not-a-stellar-address',
        amount: '0',
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: ErrorCode.BAD_REQUEST,
      message: 'Invalid Stellar payment payload',
    });

    expect(mockedStellarSubmissionService).not.toHaveBeenCalled();
  });

  it('returns cached response on duplicate key with the same payload', async () => {
    const destination = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const key = 'stellar-cached-key-1';

    const first = await request(app)
      .post(submissionPath())
      .set(authHeaders(key))
      .send({ destination, amount: '2.5000000' });

    const second = await request(app)
      .post(submissionPath())
      .set(authHeaders(key))
      .send({ destination, amount: '2.5000000' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotency-status']).toBe('cached');

    expect(submitPaymentMock).toHaveBeenCalledTimes(1);
  });

  it('returns conflict when key is reused with a different payload', async () => {
    const destination = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const key = 'stellar-mismatch-key-1';

    const first = await request(app)
      .post(submissionPath())
      .set(authHeaders(key))
      .send({ destination, amount: '4.0000000' });

    const second = await request(app)
      .post(submissionPath())
      .set(authHeaders(key))
      .send({ destination, amount: '5.0000000' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.headers['idempotency-status']).toBe('conflict');
    expect(second.body).toEqual({
      error: 'Idempotency key reuse with a different request payload is not allowed.',
    });
  });
});
