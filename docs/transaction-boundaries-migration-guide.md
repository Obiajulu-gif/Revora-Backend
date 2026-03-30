# Migration Guide: Adding Transaction Boundaries to Existing Code

This guide shows how to refactor existing Revora Backend code to use transaction boundaries.

## Step 1: Identify Code That Needs Transactions

Look for code that:
- Creates related records across multiple tables
- Updates multiple records that must stay consistent
- Has comments like "TODO: make this atomic" or "FIXME: race condition"
- Could leave data in inconsistent state if interrupted

## Step 2: Update Repository Methods

### Before: Repository without transaction support

```typescript
export class UserRepository {
  constructor(private db: Pool) {}
  
  async create(input: CreateUserInput): Promise<User> {
    const result = await this.db.query(
      'INSERT INTO users (email, name) VALUES ($1, $2) RETURNING *',
      [input.email, input.name]
    );
    return result.rows[0];
  }
}
```

### After: Repository with optional client parameter

```typescript
import { PoolClient } from 'pg';

export class UserRepository {
  constructor(private db: Pool) {}
  
  // Add optional client parameter
  async create(input: CreateUserInput, client?: PoolClient): Promise<User> {
    // Use client if provided, otherwise use pool
    const db = client || this.db;
    
    const result = await db.query(
      'INSERT INTO users (email, name) VALUES ($1, $2) RETURNING *',
      [input.email, input.name]
    );
    return result.rows[0];
  }
}
```

**Key Changes:**
1. Import `PoolClient` from 'pg'
2. Add `client?: PoolClient` parameter to methods
3. Use `const db = client || this.db;` pattern
4. Replace `this.db.query()` with `db.query()`

## Step 3: Update Service Methods

### Before: Service without transactions

```typescript
export class InvestmentService {
  constructor(
    private pool: Pool,
    private investmentRepo: InvestmentRepository,
    private auditRepo: AuditLogRepository
  ) {}
  
  async createInvestment(input: CreateInvestmentInput): Promise<Investment> {
    // Problem: If audit log creation fails, investment still exists
    const investment = await this.investmentRepo.create(input);
    await this.auditRepo.log({
      action: 'INVESTMENT_CREATED',
      entity_id: investment.id,
      user_id: input.investor_id,
    });
    return investment;
  }
}
```

### After: Service with transactions

```typescript
import { withTransaction } from '../db/transaction';

export class InvestmentService {
  constructor(
    private pool: Pool,
    private investmentRepo: InvestmentRepository,
    private auditRepo: AuditLogRepository
  ) {}
  
  async createInvestment(input: CreateInvestmentInput): Promise<Investment> {
    // Wrap in transaction for atomicity
    return withTransaction(this.pool, async (client) => {
      const investment = await this.investmentRepo.create(input, client);
      await this.auditRepo.log({
        action: 'INVESTMENT_CREATED',
        entity_id: investment.id,
        user_id: input.investor_id,
      }, client);
      return investment;
    });
  }
}
```

**Key Changes:**
1. Import `withTransaction` from '../db/transaction'
2. Wrap multi-step operations in `withTransaction()`
3. Pass `client` to repository methods
4. Return result from transaction callback

## Step 4: Update Handler Functions

### Before: Handler without transactions

```typescript
export async function createUserHandler(req: Request, res: Response) {
  const { email, name } = req.body;
  
  const user = await userRepo.create({ email, name });
  await profileRepo.create({ user_id: user.id, bio: '' });
  
  res.status(201).json(user);
}
```

### After: Handler with transactions

```typescript
import { withTransaction } from '../db/transaction';
import { pool } from '../db/pool';

export async function createUserHandler(req: Request, res: Response) {
  const { email, name } = req.body;
  
  const user = await withTransaction(pool, async (client) => {
    const newUser = await userRepo.create({ email, name }, client);
    await profileRepo.create({ user_id: newUser.id, bio: '' }, client);
    return newUser;
  });
  
  res.status(201).json(user);
}
```

## Real-World Examples from Revora Backend

### Example 1: Password Reset Service

**Before:**
```typescript
async resetPassword(tokenRaw: string, newPassword: string): Promise<boolean> {
  const tokenHash = this.hashToken(tokenRaw);
  let client: PoolClient | null = null;
  try {
    client = await this.db.connect();
    await client.query('BEGIN');
    
    const { rows } = await client.query(
      'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = $1 FOR UPDATE',
      [tokenHash]
    );
    
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    
    // ... validation logic ...
    
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, row.user_id]);
    await client.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [row.id]);
    await client.query('COMMIT');
    return true;
  } catch {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {}
    }
    throw new Error('Password reset failed');
  } finally {
    client?.release();
  }
}
```

**After:**
```typescript
import { withTransaction } from '../db/transaction';

async resetPassword(tokenRaw: string, newPassword: string): Promise<boolean> {
  const tokenHash = this.hashToken(tokenRaw);
  
  return withTransaction(this.db, async (client) => {
    const { rows } = await client.query(
      'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = $1 FOR UPDATE',
      [tokenHash]
    );
    
    if (rows.length === 0) {
      return false;
    }
    
    const row = rows[0];
    if (row.used_at || new Date(row.expires_at) < new Date()) {
      return false;
    }
    
    const passwordHash = this.hashPassword(newPassword);
    
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, row.user_id]);
    await client.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [row.id]);
    
    return true;
  });
}
```

**Benefits:**
- 15 lines shorter
- No manual BEGIN/COMMIT/ROLLBACK
- Automatic connection release
- Cleaner error handling

### Example 2: Balance Snapshot Repository

**Before:**
```typescript
async insertMany(inputs: CreateSnapshotInput[]): Promise<TokenBalanceSnapshot[]> {
  const client = await this.db.connect();
  try {
    await client.query('BEGIN');
    
    const results: TokenBalanceSnapshot[] = [];
    for (const input of inputs) {
      const query = `INSERT INTO token_balance_snapshots (...) VALUES (...) RETURNING *`;
      const values = [input.offering_id, input.period_id, ...];
      const result = await client.query(query, values);
      results.push(result.rows[0]);
    }
    
    await client.query('COMMIT');
    return results;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

**After:**
```typescript
import { withTransaction } from '../transaction';

async insertMany(inputs: CreateSnapshotInput[]): Promise<TokenBalanceSnapshot[]> {
  return withTransaction(this.db, async (client) => {
    const results: TokenBalanceSnapshot[] = [];
    
    for (const input of inputs) {
      const query = `INSERT INTO token_balance_snapshots (...) VALUES (...) RETURNING *`;
      const values = [input.offering_id, input.period_id, ...];
      const result = await client.query(query, values);
      results.push(result.rows[0]);
    }
    
    return results;
  });
}
```

### Example 3: Revenue Reconciliation Service

**Before:**
```typescript
async reconcile(offeringId: string, periodStart: Date, periodEnd: Date) {
  // Multiple queries without transaction
  const revenueReports = await this.revenueReportRepo.findByPeriod(offeringId, periodStart, periodEnd);
  const distributions = await this.distributionRepo.findByPeriod(offeringId, periodStart, periodEnd);
  const investments = await this.investmentRepo.findByOffering(offeringId);
  
  // Problem: Data could change between queries
  return this.calculateReconciliation(revenueReports, distributions, investments);
}
```

**After:**
```typescript
import { withTransaction } from '../db/transaction';

async reconcile(offeringId: string, periodStart: Date, periodEnd: Date) {
  // Use REPEATABLE READ for consistent snapshot
  return withTransaction(this.db, async (client) => {
    const revenueReports = await this.revenueReportRepo.findByPeriod(offeringId, periodStart, periodEnd, client);
    const distributions = await this.distributionRepo.findByPeriod(offeringId, periodStart, periodEnd, client);
    const investments = await this.investmentRepo.findByOffering(offeringId, client);
    
    // All queries see same data snapshot
    return this.calculateReconciliation(revenueReports, distributions, investments);
  }, { isolationLevel: 'REPEATABLE READ', readOnly: true });
}
```

## Migration Checklist

For each service/repository:

- [ ] Identify methods that need transactions
- [ ] Add `client?: PoolClient` parameter to repository methods
- [ ] Update repository methods to use `const db = client || this.db`
- [ ] Wrap multi-step operations in `withTransaction()`
- [ ] Pass `client` to all repository calls within transaction
- [ ] Remove manual BEGIN/COMMIT/ROLLBACK code
- [ ] Remove manual connection management (connect/release)
- [ ] Update tests to verify transaction behavior
- [ ] Add error handling tests
- [ ] Document transaction requirements in code comments

## Testing After Migration

### Test 1: Verify Atomicity

```typescript
it('should rollback all changes on error', async () => {
  await expect(
    service.createWithError()
  ).rejects.toThrow();
  
  // Verify no partial data exists
  const users = await pool.query('SELECT * FROM users');
  expect(users.rows).toHaveLength(0);
});
```

### Test 2: Verify Success Path

```typescript
it('should commit all changes on success', async () => {
  const result = await service.createUserWithProfile({
    email: 'test@example.com',
    name: 'Test User',
  });
  
  expect(result.user).toBeDefined();
  expect(result.profile).toBeDefined();
  
  // Verify both records exist
  const user = await pool.query('SELECT * FROM users WHERE id = $1', [result.user.id]);
  const profile = await pool.query('SELECT * FROM profiles WHERE user_id = $1', [result.user.id]);
  
  expect(user.rows).toHaveLength(1);
  expect(profile.rows).toHaveLength(1);
});
```

### Test 3: Verify Connection Release

```typescript
it('should not leak connections', async () => {
  const initialConnections = pool.totalCount;
  
  // Run multiple transactions
  for (let i = 0; i < 10; i++) {
    await service.createUser({ email: `user${i}@example.com` });
  }
  
  // Wait for connections to be released
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Should not have more connections than before
  expect(pool.totalCount).toBeLessThanOrEqual(initialConnections + 1);
});
```

## Common Issues and Solutions

### Issue 1: "Cannot read property 'query' of undefined"

**Cause:** Forgot to pass `client` to repository method

**Solution:**
```typescript
// ❌ Wrong
await withTransaction(pool, async (client) => {
  await userRepo.create({ email }); // Missing client!
});

// ✅ Correct
await withTransaction(pool, async (client) => {
  await userRepo.create({ email }, client);
});
```

### Issue 2: "Connection pool exhausted"

**Cause:** Transaction held open too long or not released

**Solution:**
- Keep transactions short
- Don't make external API calls inside transactions
- Ensure `withTransaction()` is used correctly (it auto-releases)

### Issue 3: "Serialization failure"

**Cause:** Concurrent transactions with SERIALIZABLE isolation

**Solution:**
```typescript
// Add retry logic for serialization failures
async function retryableOperation() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await withTransaction(pool, async (client) => {
        // ... operations ...
      }, { isolationLevel: 'SERIALIZABLE' });
    } catch (error) {
      if (error.cause?.code === '40001' && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt)));
        continue;
      }
      throw error;
    }
  }
}
```

## Gradual Migration Strategy

1. **Phase 1**: Add transaction support to repositories (add optional `client` parameter)
2. **Phase 2**: Identify critical paths that need transactions
3. **Phase 3**: Migrate critical paths first (user registration, payments, etc.)
4. **Phase 4**: Migrate remaining code gradually
5. **Phase 5**: Remove old manual transaction code

## Need Help?

- See full documentation: `docs/repository-transaction-boundaries.md`
- See examples: `src/db/transaction.example.ts` and `src/db/transaction.integration.example.ts`
- See tests: `src/db/transaction.test.ts`
- Quick reference: `docs/transaction-boundaries-quick-start.md`
