import assert from 'assert';
import { createPayoutsHandlers, Payout, PayoutListResponse } from './payouts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

class MockPayoutRepo {
  constructor(private rows: Payout[]) {}
  async listPayoutsByInvestor(investorId: string): Promise<Payout[]> {
    return this.rows.filter((p) => p.investor_id === investorId);
  }
}

function makeReq(user: any, query: any = {}) {
  return { user, query } as any;
}

function makeRes() {
  let statusCode = 200;
  let jsonData: any = null;
  return {
    status(code: number) { statusCode = code; return this; },
    json(obj: any) { jsonData = obj; return this; },
    _get() { return { statusCode, jsonData }; },
  } as any;
}

function makePayout(overrides: Partial<Payout> = {}): Payout {
  return {
    id: 'pay-1',
    distribution_run_id: 'run-1',
    investor_id: 'inv-1',
    amount: '50.00',
    status: 'processed',
    transaction_hash: '0xabc',
    created_at: new Date('2024-01-10'),
    updated_at: new Date('2024-01-10'),
    ...overrides,
  };
}

const INVESTOR = { id: 'inv-1', role: 'investor' };
const next = (e: any) => { throw e; };

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PAYOUTS: Payout[] = [
  makePayout({ id: 'pay-1', investor_id: 'inv-1', status: 'processed', amount: '100.00', created_at: new Date('2024-01-01') }),
  makePayout({ id: 'pay-2', investor_id: 'inv-1', status: 'processed', amount: '200.00', created_at: new Date('2024-01-02') }),
  makePayout({ id: 'pay-3', investor_id: 'inv-1', status: 'pending',   amount: '50.00',  created_at: new Date('2024-01-03') }),
  makePayout({ id: 'pay-4', investor_id: 'inv-1', status: 'failed',    amount: '75.00',  created_at: new Date('2024-01-04') }),
  makePayout({ id: 'pay-5', investor_id: 'inv-2', status: 'processed', amount: '999.00', created_at: new Date('2024-01-05') }),
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('payouts routes', () => {
  const repo = new MockPayoutRepo(PAYOUTS);
  const handlers = createPayoutsHandlers(repo as any);

  // ═══════════════════════════════════════════════════════════════════════════
  // Auth & authorization
  // ═══════════════════════════════════════════════════════════════════════════

  describe('auth boundaries', () => {
    it('returns 401 when no user', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(null), res, next);
      assert.strictEqual(res._get().statusCode, 401);
    });

    it('returns 401 when user has no id', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq({ role: 'investor' }), res, next);
      assert.strictEqual(res._get().statusCode, 401);
    });

    it('returns 403 for issuer role', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq({ id: 'u1', role: 'issuer' }), res, next);
      assert.strictEqual(res._get().statusCode, 403);
    });

    it('returns 403 for startup role', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq({ id: 'u1', role: 'startup' }), res, next);
      assert.strictEqual(res._get().statusCode, 403);
    });

    it('returns 403 for admin role', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq({ id: 'u1', role: 'admin' }), res, next);
      assert.strictEqual(res._get().statusCode, 403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Basic listing (no filters)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('basic listing', () => {
    it('returns only the requesting investor payouts', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR), res, next);
      const { statusCode, jsonData } = res._get();
      assert.strictEqual(statusCode, 200);
      assert(Array.isArray(jsonData.payouts));
      assert.strictEqual(jsonData.payouts.length, 4);
      assert.strictEqual(jsonData.total, 4);
      assert(jsonData.payouts.every((p: Payout) => p.investor_id === 'inv-1'));
    });

    it('returns empty for investor with no payouts', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq({ id: 'inv-99', role: 'investor' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 0);
      assert.strictEqual(jsonData.total, 0);
      assert.strictEqual(jsonData.hasMore, false);
    });

    it('includes pagination metadata in response', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(typeof jsonData.limit, 'number');
      assert.strictEqual(typeof jsonData.offset, 'number');
      assert.strictEqual(typeof jsonData.hasMore, 'boolean');
      assert.strictEqual(typeof jsonData.total, 'number');
    });

    it('uses default limit of 20 when not specified', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.limit, 20);
      assert.strictEqual(jsonData.offset, 0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Status filter
  // ═══════════════════════════════════════════════════════════════════════════

  describe('status filter', () => {
    it('filters by status=processed', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { status: 'processed' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 2);
      assert.strictEqual(jsonData.total, 2);
      assert(jsonData.payouts.every((p: Payout) => p.status === 'processed'));
    });

    it('filters by status=pending', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { status: 'pending' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 1);
      assert.strictEqual(jsonData.payouts[0].id, 'pay-3');
    });

    it('filters by status=failed', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { status: 'failed' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 1);
      assert.strictEqual(jsonData.payouts[0].id, 'pay-4');
    });

    it('returns 400 for unknown status value', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { status: 'xyz' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
      assert(res._get().jsonData.error.includes('Invalid status'));
    });

    it('returns 400 for status=completed (not in enum)', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { status: 'completed' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Pagination
  // ═══════════════════════════════════════════════════════════════════════════

  describe('pagination', () => {
    it('paginates with limit only', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { limit: '2' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 2);
      assert.strictEqual(jsonData.total, 4);
      assert.strictEqual(jsonData.limit, 2);
      assert.strictEqual(jsonData.hasMore, true);
    });

    it('paginates with offset only', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { offset: '2' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 2);
      assert.strictEqual(jsonData.offset, 2);
    });

    it('paginates with limit + offset', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { limit: '1', offset: '1' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 1);
      assert.strictEqual(jsonData.hasMore, true);
    });

    it('hasMore is false when all results are returned', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { limit: '100' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.hasMore, false);
    });

    it('returns 400 for negative limit', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { limit: '-1' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
    });

    it('returns 400 for negative offset', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { offset: '-5' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
    });

    it('returns 400 for non-numeric limit', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { limit: 'abc' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
    });

    it('returns 400 for non-numeric offset', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { offset: 'xyz' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
    });

    it('caps limit at 100 when client requests more', async () => {
      // Create a repo with > 100 items
      const manyPayouts = Array.from({ length: 150 }, (_, i) =>
        makePayout({ id: `pay-m-${i}`, investor_id: 'inv-many', status: 'processed', amount: '10.00', created_at: new Date('2024-01-01') }),
      );
      const bigRepo = new MockPayoutRepo(manyPayouts);
      const bigHandlers = createPayoutsHandlers(bigRepo as any);

      const res = makeRes();
      await bigHandlers.listPayouts(makeReq({ id: 'inv-many', role: 'investor' }, { limit: '500' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.limit, 100);
      assert.strictEqual(jsonData.payouts.length, 100);
      assert.strictEqual(jsonData.hasMore, true);
    });

    it('returns empty array when offset exceeds total', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { offset: '1000' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 0);
      assert.strictEqual(jsonData.total, 4);
      assert.strictEqual(jsonData.hasMore, false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Amount range filters
  // ═══════════════════════════════════════════════════════════════════════════

  describe('amount range filters', () => {
    it('filters by minAmount only', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { minAmount: '100' }), res, next);
      const { jsonData } = res._get();
      assert(jsonData.payouts.every((p: Payout) => parseFloat(p.amount) >= 100));
      assert.strictEqual(jsonData.payouts.length, 2); // 100 and 200
    });

    it('filters by maxAmount only', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { maxAmount: '75' }), res, next);
      const { jsonData } = res._get();
      assert(jsonData.payouts.every((p: Payout) => parseFloat(p.amount) <= 75));
      assert.strictEqual(jsonData.payouts.length, 2); // 50 and 75
    });

    it('filters by both minAmount and maxAmount', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { minAmount: '60', maxAmount: '150' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 2); // 75 and 100
    });

    it('returns 400 for non-numeric minAmount', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { minAmount: 'abc' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
      assert(res._get().jsonData.error.includes('minAmount'));
    });

    it('returns 400 for non-numeric maxAmount', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { maxAmount: 'xyz' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
      assert(res._get().jsonData.error.includes('maxAmount'));
    });

    it('returns 400 for negative minAmount', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { minAmount: '-10' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
    });

    it('returns 400 for negative maxAmount', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { maxAmount: '-5' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
    });

    it('returns empty when no payouts match amount range', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { minAmount: '500', maxAmount: '600' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 0);
      assert.strictEqual(jsonData.total, 0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Date range filters
  // ═══════════════════════════════════════════════════════════════════════════

  describe('date range filters', () => {
    it('filters by from date only', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { from: '2024-01-03' }), res, next);
      const { jsonData } = res._get();
      // pay-3 (Jan 3) and pay-4 (Jan 4)
      assert.strictEqual(jsonData.payouts.length, 2);
    });

    it('filters by to date only', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { to: '2024-01-02' }), res, next);
      const { jsonData } = res._get();
      // pay-1 (Jan 1) and pay-2 (Jan 2)
      assert.strictEqual(jsonData.payouts.length, 2);
    });

    it('filters by both from and to dates', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { from: '2024-01-02', to: '2024-01-03' }), res, next);
      const { jsonData } = res._get();
      // pay-2 (Jan 2) and pay-3 (Jan 3)
      assert.strictEqual(jsonData.payouts.length, 2);
    });

    it('returns 400 for invalid from date', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { from: 'not-a-date' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
      assert(res._get().jsonData.error.includes('from'));
    });

    it('returns 400 for invalid to date', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { to: 'garbage' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
      assert(res._get().jsonData.error.includes('to'));
    });

    it('returns empty when no payouts match date range', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { from: '2025-01-01', to: '2025-12-31' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Sorting
  // ═══════════════════════════════════════════════════════════════════════════

  describe('sorting', () => {
    it('sorts by created_at desc by default', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR), res, next);
      const { jsonData } = res._get();
      const dates = jsonData.payouts.map((p: Payout) => new Date(p.created_at).getTime());
      for (let i = 1; i < dates.length; i++) {
        assert(dates[i] <= dates[i - 1], 'should be descending by created_at');
      }
    });

    it('sorts by created_at asc', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { sortOrder: 'asc' }), res, next);
      const { jsonData } = res._get();
      const dates = jsonData.payouts.map((p: Payout) => new Date(p.created_at).getTime());
      for (let i = 1; i < dates.length; i++) {
        assert(dates[i] >= dates[i - 1], 'should be ascending by created_at');
      }
    });

    it('sorts by amount desc', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { sortBy: 'amount', sortOrder: 'desc' }), res, next);
      const { jsonData } = res._get();
      const amounts = jsonData.payouts.map((p: Payout) => parseFloat(p.amount));
      for (let i = 1; i < amounts.length; i++) {
        assert(amounts[i] <= amounts[i - 1], 'should be descending by amount');
      }
    });

    it('sorts by amount asc', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { sortBy: 'amount', sortOrder: 'asc' }), res, next);
      const { jsonData } = res._get();
      const amounts = jsonData.payouts.map((p: Payout) => parseFloat(p.amount));
      for (let i = 1; i < amounts.length; i++) {
        assert(amounts[i] >= amounts[i - 1], 'should be ascending by amount');
      }
    });

    it('sorts by status', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { sortBy: 'status', sortOrder: 'asc' }), res, next);
      const { jsonData } = res._get();
      const statuses = jsonData.payouts.map((p: Payout) => p.status);
      for (let i = 1; i < statuses.length; i++) {
        assert(statuses[i] >= statuses[i - 1], 'should be ascending by status');
      }
    });

    it('returns 400 for invalid sortBy', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { sortBy: 'hackerfield' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
      assert(res._get().jsonData.error.includes('sortBy'));
    });

    it('returns 400 for invalid sortOrder', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { sortOrder: 'random' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
      assert(res._get().jsonData.error.includes('sortOrder'));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Combined filters + pagination + sorting
  // ═══════════════════════════════════════════════════════════════════════════

  describe('combined filters', () => {
    it('applies status + amount + date + sort + pagination together', async () => {
      const res = makeRes();
      await handlers.listPayouts(
        makeReq(INVESTOR, {
          status: 'processed',
          minAmount: '50',
          from: '2024-01-01',
          to: '2024-01-05',
          sortBy: 'amount',
          sortOrder: 'asc',
          limit: '1',
          offset: '0',
        }),
        res,
        next,
      );
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 1);
      assert.strictEqual(jsonData.total, 2); // pay-1 (100) and pay-2 (200) are both processed
      assert.strictEqual(jsonData.hasMore, true);
      // First by amount asc = 100.00
      assert.strictEqual(jsonData.payouts[0].amount, '100.00');
    });

    it('combined: second page of previous query', async () => {
      const res = makeRes();
      await handlers.listPayouts(
        makeReq(INVESTOR, {
          status: 'processed',
          minAmount: '50',
          from: '2024-01-01',
          to: '2024-01-05',
          sortBy: 'amount',
          sortOrder: 'asc',
          limit: '1',
          offset: '1',
        }),
        res,
        next,
      );
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 1);
      assert.strictEqual(jsonData.payouts[0].amount, '200.00');
      assert.strictEqual(jsonData.hasMore, false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Error handling
  // ═══════════════════════════════════════════════════════════════════════════

  describe('error handling', () => {
    it('calls next(err) on repository failure', async () => {
      const failingRepo = { listPayoutsByInvestor: async () => { throw new Error('DB error'); } };
      const failHandlers = createPayoutsHandlers(failingRepo as any);
      let capturedErr: any = null;
      const res = makeRes();
      await failHandlers.listPayouts(makeReq(INVESTOR), res, (e: any) => { capturedErr = e; });
      assert(capturedErr instanceof Error && capturedErr.message === 'DB error');
    });
  });
});
