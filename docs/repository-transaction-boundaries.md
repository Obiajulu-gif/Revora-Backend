# Repository Transaction Boundaries

## Overview

Repository transaction boundaries provide atomic database operations with automatic commit/rollback semantics. This ensures data consistency by guaranteeing that either all changes in a transaction succeed together, or all fail together with no partial writes.

## What Are Transaction Boundaries?

A transaction boundary defines the scope of atomic database operations. Within a transaction:

- **Atomicity**: All operations succeed or all fail together
- **Consistency**: Database constraints are enforced
- **Isolation**: Concurrent transactions don't interfere with each other
- **Durability**: Committed changes persist permanently

Transaction boundaries prevent common data integrity issues:
- Partial writes when operations fail midway
- Race conditions from concurrent access
- Orphaned records from incomplete multi-table operations
- Connection leaks from unreleased database connections

## Why Transaction Boundaries Matter

### Without Transactions (Problematic)

```typescript
// ❌ UNSAFE: Partial writes possible
async function createUserWithProfile(email: string, name: string) {
  const user = await userRepo.create({ email });
  // If this fails, user exists but profile doesn't
  const profile = await profileRepo.create({ userId: user.id, name });
  return { user, profile };
}
```

If the profile creation fails, the user record remains in the database, creating an inconsistent state.

### With Transactions (Safe)

```typescript
// ✅ SAFE: All-or-nothing guarantee
async function createUserWithProfile(email: string, name: string) {
  return withTransaction(pool, async (client) => {
    const user = await userRepo.create({ email }, client);
    const profile = await profileRepo.create({ userId: user.id, name }, client);
    return { user, profile };
  });
  // If profile creation fails, user creation is automatically rolled back
}
```

## Transaction Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│                    Transaction Lifecycle                     │
└─────────────────────────────────────────────────────────────┘

1. Acquire Connection
   ↓
   pool.connect() → PoolClient
   
2. Begin Transaction
   ↓
   BEGIN [ISOLATION LEVEL ...] [READ ONLY]
   
3. Execute Operations
   ↓
   ┌─────────────────────────────────────┐
   │  Your callback function executes    │
   │  - All queries use same client      │
   │  - Changes are not yet visible      │
   │    to other transactions            │
   └─────────────────────────────────────┘
   
4. Commit or Rollback
   ↓
   ┌─────────────┬─────────────┐
   │  Success    │   Error     │
   ├─────────────┼─────────────┤
   │  COMMIT     │  ROLLBACK   │
   │  Changes    │  All changes│
   │  persisted  │  discarded  │
   └─────────────┴─────────────┘
   
5. Release Connection
   ↓
   client.release() → back to pool
   (Always happens, even on error)
```

## Security Assumptions and Guarantees

### Input Validation

All inputs are validated **before** starting a transaction:

```typescript
export async function withTransaction<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {}
): Promise<T> {
  // ✅ Validate BEFORE acquiring connection
  if (!pool) {
    throw new TransactionError('Pool is required');
  }
  if (typeof callback !== 'function') {
    throw new TransactionError('Callback must be a function');
  }
  
  // Now safe to proceed...
}
```

### Preventing Partial Writes

Transactions guarantee atomicity:

```typescript
try {
  await withTransaction(pool, async (client) => {
    await client.query('INSERT INTO orders (id) VALUES ($1)', [orderId]);
    await client.query('INSERT INTO order_items (order_id) VALUES ($1)', [orderId]);
    // If this fails ↓
    await client.query('UPDATE inventory SET stock = stock - 1');
  });
} catch (error) {
  // All three operations are rolled back
  // No partial order exists in database
}
```

### No Connection Leaks

Connections are **always** released, even on error:

```typescript
} finally {
  // Release connection back to pool (only for top-level transactions)
  if (client && !isNestedTransaction) {
    client.release(); // ✅ Always executes
  }
}
```

### Sanitized Error Messages

Sensitive data is removed from error messages:

```typescript
function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    let message = error.message;
    
    // Remove connection strings
    message = message.replace(/postgresql:\/\/[^\s]+/gi, 'postgresql://[REDACTED]');
    
    // Remove passwords
    message = message.replace(/password[=:]\s*['"]?[^'"\s]+['"]?/gi, 'password=[REDACTED]');
    
    // Remove tokens/keys
    message = message.replace(/[a-z0-9]{32,}/gi, '[REDACTED]');
    
    return message;
  }
  return 'Unknown error';
}
```

### Concurrent Transaction Conflicts

Transactions handle serialization failures and deadlocks:

```typescript
try {
  await withTransaction(pool, async (client) => {
    await client.query('UPDATE accounts SET balance = balance - 100 WHERE id = $1', [accountId]);
  }, { isolationLevel: 'SERIALIZABLE' });
} catch (error) {
  if (error.code === '40001') {
    // Serialization failure - retry logic can be implemented
  }
  if (error.code === '40P01') {
    // Deadlock detected - retry with backoff
  }
}
```

## Error Handling Behavior

### Automatic Rollback

Errors trigger automatic rollback:

```typescript
await withTransaction(pool, async (client) => {
  await client.query('INSERT INTO users (email) VALUES ($1)', ['user@example.com']);
  throw new Error('Something went wrong');
  // ROLLBACK is automatically called
  // User is NOT inserted
});
```

### Rollback Failure Handling

If rollback fails, the error is logged but the original error is still thrown:

```typescript
try {
  await withTransaction(pool, async (client) => {
    await client.query('INVALID SQL');
  });
} catch (error) {
  console.log(error.rollbackSucceeded); // false if rollback failed
  // Original error is still thrown
  // Connection is still released
}
```

### Error Propagation

Original errors are preserved in the `cause` property:

```typescript
try {
  await withTransaction(pool, async (client) => {
    await client.query('INVALID SQL');
  });
} catch (error) {
  console.log(error instanceof TransactionError); // true
  console.log(error.cause); // Original database error
  console.log(error.rollbackSucceeded); // true/false
}
```

## Usage Examples

### Basic Transaction

```typescript
import { withTransaction } from './db/transaction';
import { pool } from './db/pool';

async function createUser(email: string, name: string) {
  return withTransaction(pool, async (client) => {
    const userResult = await client.query(
      'INSERT INTO users (email, name) VALUES ($1, $2) RETURNING *',
      [email, name]
    );
    
    const user = userResult.rows[0];
    
    await client.query(
      'INSERT INTO audit_logs (action, user_id) VALUES ($1, $2)',
      ['USER_CREATED', user.id]
    );
    
    return user;
  });
}
```

### Multiple Operations

```typescript
async function transferFunds(fromAccountId: string, toAccountId: string, amount: number) {
  return withTransaction(pool, async (client) => {
    // Debit from account
    await client.query(
      'UPDATE accounts SET balance = balance - $1 WHERE id = $2',
      [amount, fromAccountId]
    );
    
    // Credit to account
    await client.query(
      'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
      [amount, toAccountId]
    );
    
    // Record transaction
    await client.query(
      'INSERT INTO transactions (from_account, to_account, amount) VALUES ($1, $2, $3)',
      [fromAccountId, toAccountId, amount]
    );
    
    return { success: true };
  });
}
```

### Nested Transactions (Savepoints)

**Note**: The current implementation creates independent transactions for nested calls. True nested transaction support via savepoints will be added in a future update.

```typescript
async function createOrderWithItems(order: Order, items: OrderItem[]) {
  return withTransaction(pool, async (client) => {
    // Create order
    const orderResult = await client.query(
      'INSERT INTO orders (customer_id, total) VALUES ($1, $2) RETURNING *',
      [order.customerId, order.total]
    );
    
    const orderId = orderResult.rows[0].id;
    
    // Create items - each in the same transaction
    for (const item of items) {
      await client.query(
        'INSERT INTO order_items (order_id, product_id, quantity) VALUES ($1, $2, $3)',
        [orderId, item.productId, item.quantity]
      );
      
      await client.query(
        'UPDATE inventory SET stock = stock - $1 WHERE product_id = $2',
        [item.quantity, item.productId]
      );
    }
    
    return orderResult.rows[0];
  });
}
```

### Custom Isolation Level

```typescript
async function generateReport(offeringId: string) {
  // Use REPEATABLE READ to ensure consistent snapshot
  return withTransaction(pool, async (client) => {
    const revenue = await client.query(
      'SELECT SUM(amount) FROM revenue_reports WHERE offering_id = $1',
      [offeringId]
    );
    
    const distributions = await client.query(
      'SELECT SUM(total_amount) FROM distribution_runs WHERE offering_id = $1',
      [offeringId]
    );
    
    return {
      revenue: revenue.rows[0].sum,
      distributions: distributions.rows[0].sum,
    };
  }, { isolationLevel: 'REPEATABLE READ' });
}
```

### Read-Only Transaction

```typescript
async function getConsistentSnapshot(userId: string) {
  return withTransaction(pool, async (client) => {
    const user = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
    const orders = await client.query('SELECT * FROM orders WHERE user_id = $1', [userId]);
    const payments = await client.query('SELECT * FROM payments WHERE user_id = $1', [userId]);
    
    return {
      user: user.rows[0],
      orders: orders.rows,
      payments: payments.rows,
    };
  }, { readOnly: true });
}
```

### Using transactional() Helper

```typescript
import { transactional } from './db/transaction';

async function bulkCreateUsers(emails: string[]) {
  const operations = emails.map(email => 
    (client: PoolClient) => client.query(
      'INSERT INTO users (email) VALUES ($1) RETURNING *',
      [email]
    )
  );
  
  const results = await transactional(pool, operations);
  return results.map(r => r.rows[0]);
}
```

## Edge Cases and Known Limitations

### Nested Transaction Limitations

**Current Implementation**: Nested calls to `withTransaction` create independent transactions rather than using savepoints. This means:

- Each nested call acquires its own connection from the pool
- Nested transactions commit/rollback independently
- True savepoint support will be added in a future update

For now, keep all related operations in a single transaction:

```typescript
// ✅ GOOD: All operations in one transaction
await withTransaction(pool, async (client) => {
  await client.query('INSERT INTO orders (id) VALUES ($1)', ['order-1']);
  await client.query('INSERT INTO order_items (order_id) VALUES ($1)', ['order-1']);
  await client.query('UPDATE orders SET status = $1 WHERE id = $2', ['pending', 'order-1']);
});

// ⚠️ AVOID: Nested withTransaction calls (creates separate transactions)
await withTransaction(pool, async (client) => {
  await client.query('INSERT INTO orders (id) VALUES ($1)', ['order-1']);
  
  // This creates a separate transaction
  await withTransaction(pool, async (nestedClient) => {
    await nestedClient.query('INSERT INTO order_items (order_id) VALUES ($1)', ['order-1']);
  });
});
```

### Long-Running Transactions

Long transactions can cause:
- Connection pool exhaustion
- Lock contention
- Increased rollback cost

**Best Practice**: Keep transactions short and focused.

```typescript
// ❌ BAD: Long-running transaction
await withTransaction(pool, async (client) => {
  for (let i = 0; i < 10000; i++) {
    await client.query('INSERT INTO logs (message) VALUES ($1)', [`Log ${i}`]);
  }
});

// ✅ GOOD: Batch operations
await withTransaction(pool, async (client) => {
  const values = Array.from({ length: 10000 }, (_, i) => `('Log ${i}')`).join(',');
  await client.query(`INSERT INTO logs (message) VALUES ${values}`);
});
```

### Serialization Failures

With `SERIALIZABLE` isolation, concurrent transactions may fail:

```typescript
async function retryableTransaction<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>,
  maxRetries = 3
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await withTransaction(pool, callback, { isolationLevel: 'SERIALIZABLE' });
    } catch (error) {
      if (error.cause?.code === '40001' && attempt < maxRetries - 1) {
        // Serialization failure - retry
        await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt)));
        continue;
      }
      throw error;
    }
  }
  throw new Error('Max retries exceeded');
}
```

### Connection Pool Exhaustion

If all connections are in use, `pool.connect()` will wait:

```typescript
// Configure pool with appropriate size
const pool = new Pool({
  max: 20, // Maximum connections
  connectionTimeoutMillis: 5000, // Wait up to 5s for connection
});

// Monitor pool health
pool.on('error', (err) => {
  console.error('Unexpected pool error:', err);
});
```

### DDL Operations in Transactions

Some DDL operations cannot be rolled back:

```typescript
// ⚠️ WARNING: CREATE DATABASE cannot be rolled back
await withTransaction(pool, async (client) => {
  await client.query('CREATE DATABASE new_db'); // Not transactional
});

// ✅ SAFE: Most DDL operations are transactional in PostgreSQL
await withTransaction(pool, async (client) => {
  await client.query('CREATE TABLE users (id SERIAL PRIMARY KEY)');
  await client.query('CREATE INDEX idx_users_email ON users(email)');
});
```

## Integration with Repositories

Repositories should accept an optional client parameter:

```typescript
export class UserRepository {
  constructor(private pool: Pool) {}
  
  async create(input: CreateUserInput, client?: PoolClient): Promise<User> {
    const db = client || this.pool;
    
    const result = await db.query(
      'INSERT INTO users (email, name) VALUES ($1, $2) RETURNING *',
      [input.email, input.name]
    );
    
    return result.rows[0];
  }
}

// Usage with transaction
await withTransaction(pool, async (client) => {
  const userRepo = new UserRepository(pool);
  const user = await userRepo.create({ email: 'test@example.com', name: 'Test' }, client);
  
  const profileRepo = new ProfileRepository(pool);
  const profile = await profileRepo.create({ userId: user.id, bio: 'Hello' }, client);
  
  return { user, profile };
});
```

## Performance Considerations

### Transaction Overhead

Transactions have minimal overhead but should still be used judiciously:

- **BEGIN/COMMIT**: ~0.1ms overhead
- **Locks**: Held until commit/rollback
- **WAL writes**: Occur at commit time

### Optimization Tips

1. **Batch operations** when possible
2. **Keep transactions short** to reduce lock contention
3. **Use appropriate isolation levels** (READ COMMITTED is usually sufficient)
4. **Avoid network calls** inside transactions
5. **Prepare statements** for repeated queries

```typescript
// ✅ GOOD: Short, focused transaction
await withTransaction(pool, async (client) => {
  await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [100, accountId]);
  await client.query('INSERT INTO transactions (account_id, amount) VALUES ($1, $2)', [accountId, -100]);
});

// ❌ BAD: Long transaction with external calls
await withTransaction(pool, async (client) => {
  await client.query('INSERT INTO orders (id) VALUES ($1)', [orderId]);
  await fetch('https://api.example.com/notify'); // ❌ Network call in transaction
  await client.query('UPDATE inventory SET stock = stock - 1');
});
```

## Testing Transactions

Use mocks to test transaction behavior:

```typescript
describe('Transaction Tests', () => {
  it('should rollback on error', async () => {
    const mockClient = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockRejectedValueOnce(new Error('Query failed'))
        .mockResolvedValueOnce({ rows: [] }), // ROLLBACK
      release: jest.fn(),
    };
    
    const mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
    };
    
    await expect(
      withTransaction(mockPool as any, async (client) => {
        await client.query('INVALID SQL');
      })
    ).rejects.toThrow();
    
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalled();
  });
});
```

## References

- [PostgreSQL Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [node-postgres Transactions](https://node-postgres.com/features/transactions)
- [ACID Properties](https://en.wikipedia.org/wiki/ACID)

---

**Issue Reference**: issue-168  
**Implementation Date**: 2026-03-30  
**Author**: Kiro AI Assistant
