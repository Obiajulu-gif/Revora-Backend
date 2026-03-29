import DistributionEngine, { BalanceRow } from './distributionEngine';

class MockDistributionRepo {
  public runs: any[] = [];
  public payouts: any[] = [];
  public failNextRunCount = 0;
  public failNextPayoutCount = 0;

  async createDistributionRun(input: any): Promise<any> {
    if (this.failNextRunCount > 0) {
      this.failNextRunCount -= 1;
      throw new Error('Database error (run)');
    }

    const run = { id: `run-${this.runs.length + 1}`, ...input };
    this.runs.push(run);
    return run;
  }

  async createPayout(input: any): Promise<any> {
    if (this.failNextPayoutCount > 0) {
      this.failNextPayoutCount -= 1;
      throw new Error('Database error (payout)');
    }

    const payout = { id: `p-${this.payouts.length + 1}`, ...input };
    this.payouts.push(payout);
    return payout;
  }
}

class MockBalanceProvider {
  constructor(private readonly balances: BalanceRow[]) {}

  async getBalances(_offeringId: string, _period: { start: Date; end: Date }): Promise<BalanceRow[]> {
    return this.balances;
  }
}

describe('DistributionEngine', () => {
  it('prorates payouts correctly', async () => {
    const repo = new MockDistributionRepo();
    const balances = [
      { investor_id: 'i1', balance: 70 },
      { investor_id: 'i2', balance: 30 },
    ];

    const engine = new DistributionEngine(
      null,
      repo,
      new MockBalanceProvider(balances),
      { maxRetries: 1, initialDelayMs: 0 },
    );

    const result = await engine.distribute(
      'off-1',
      { start: new Date('2026-01-01'), end: new Date('2026-01-31') },
      100,
    );

    expect(result.payouts).toEqual([
      { investor_id: 'i1', amount: '70.00' },
      { investor_id: 'i2', amount: '30.00' },
    ]);
    expect(repo.runs).toHaveLength(1);
    expect(repo.payouts).toHaveLength(2);
  });

  it('preserves payout total after rounding', async () => {
    const repo = new MockDistributionRepo();
    const balances = [
      { investor_id: 'i1', balance: 1 },
      { investor_id: 'i2', balance: 1 },
      { investor_id: 'i3', balance: 1 },
    ];

    const engine = new DistributionEngine(
      null,
      repo,
      new MockBalanceProvider(balances),
      { maxRetries: 1, initialDelayMs: 0 },
    );

    const result = await engine.distribute(
      'off-2',
      { start: new Date('2026-02-01'), end: new Date('2026-02-28') },
      100,
    );

    const sum = result.payouts.reduce((acc, item) => acc + Number(item.amount), 0);
    expect(sum).toBeCloseTo(100, 2);
  });

  it('throws when total balance is zero', async () => {
    const repo = new MockDistributionRepo();
    const engine = new DistributionEngine(
      null,
      repo,
      new MockBalanceProvider([{ investor_id: 'i1', balance: 0 }]),
      { maxRetries: 1, initialDelayMs: 0 },
    );

    await expect(
      engine.distribute(
        'off-3',
        { start: new Date('2026-03-01'), end: new Date('2026-03-31') },
        50,
      ),
    ).rejects.toThrow('Total balance must be > 0 to distribute revenue');
  });

  it('retries transient run creation failures', async () => {
    const repo = new MockDistributionRepo();
    repo.failNextRunCount = 1;

    const engine = new DistributionEngine(
      null,
      repo,
      new MockBalanceProvider([{ investor_id: 'i1', balance: 100 }]),
      { maxRetries: 2, initialDelayMs: 0, backoffFactor: 1 },
    );

    const result = await engine.distribute(
      'off-4',
      { start: new Date('2026-04-01'), end: new Date('2026-04-30') },
      20,
    );

    expect(result.distributionRun.id).toBe('run-1');
    expect(result.payouts).toEqual([{ investor_id: 'i1', amount: '20.00' }]);
  });
});
