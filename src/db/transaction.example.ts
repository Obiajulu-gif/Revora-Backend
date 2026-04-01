/**
 * Example usage of transaction boundaries
 * This file demonstrates how to use withTransaction in your repositories and services
 */

import { Pool, PoolClient } from 'pg';
import { withTransaction, transactional } from './transaction';

// Example 1: Simple transaction with user creation
export async function createUserExample(pool: Pool, email: string, name: string) {
  return withTransaction(pool, async (client) => {
    // Insert user
    const userResult = await client.query(
      'INSERT INTO users (email, name) VALUES ($1, $2) RETURNING *',
      [email, name]
    );
    
    const user = userResult.rows[0];
    
    // Create audit log
    await client.query(
      'INSERT INTO audit_logs (action, user_id, details) VALUES ($1, $2, $3)',
      ['USER_CREATED', user.id, JSON.stringify({ email, name })]
    );
    
    return user;
  });
}

// Example 2: Fund transfer with multiple operations
export async function transferFundsExample(
  pool: Pool,
  fromAccountId: string,
  toAccountId: string,
  amount: number
) {
  return withTransaction(pool, async (client) => {
    // Debit from source account
    const debitResult = await client.query(
      'UPDATE accounts SET balance = balance - $1 WHERE id = $2 RETURNING balance',
      [amount, fromAccountId]
    );
    
    if (debitResult.rows[0].balance < 0) {
      throw new Error('Insufficient funds');
    }
    
    // Credit to destination account
    await client.query(
      'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
      [amount, toAccountId]
    );
    
    // Record transaction
    await client.query(
      'INSERT INTO transactions (from_account, to_account, amount, created_at) VALUES ($1, $2, $3, NOW())',
      [fromAccountId, toAccountId, amount]
    );
    
    return { success: true, amount };
  });
}

// Example 3: Using transactional helper for batch operations
export async function createMultipleUsersExample(pool: Pool, users: Array<{ email: string; name: string }>) {
  const operations = users.map(user => 
    (client: PoolClient) => client.query(
      'INSERT INTO users (email, name) VALUES ($1, $2) RETURNING *',
      [user.email, user.name]
    )
  );
  
  const results = await transactional(pool, operations);
  return results.map(r => r.rows[0]);
}

// Example 4: Repository pattern with optional client
export class UserRepository {
  constructor(private pool: Pool) {}
  
  async create(input: { email: string; name: string }, client?: PoolClient) {
    const db = client || this.pool;
    
    const result = await db.query(
      'INSERT INTO users (email, name) VALUES ($1, $2) RETURNING *',
      [input.email, input.name]
    );
    
    return result.rows[0];
  }
  
  async findById(id: string, client?: PoolClient) {
    const db = client || this.pool;
    
    const result = await db.query(
      'SELECT * FROM users WHERE id = $1',
      [id]
    );
    
    return result.rows[0] || null;
  }
}

// Example 5: Using repository with transaction
export async function createUserWithProfileExample(
  pool: Pool,
  email: string,
  name: string,
  bio: string
) {
  return withTransaction(pool, async (client) => {
    const userRepo = new UserRepository(pool);
    
    // Create user within transaction
    const user = await userRepo.create({ email, name }, client);
    
    // Create profile within same transaction
    await client.query(
      'INSERT INTO profiles (user_id, bio) VALUES ($1, $2)',
      [user.id, bio]
    );
    
    return { user, profile: { user_id: user.id, bio } };
  });
}

// Example 6: Read-only transaction for consistent snapshot
export async function getAccountSummaryExample(pool: Pool, userId: string) {
  return withTransaction(pool, async (client) => {
    const userResult = await client.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );
    
    const accountsResult = await client.query(
      'SELECT * FROM accounts WHERE user_id = $1',
      [userId]
    );
    
    const transactionsResult = await client.query(
      'SELECT * FROM transactions WHERE from_account IN (SELECT id FROM accounts WHERE user_id = $1) OR to_account IN (SELECT id FROM accounts WHERE user_id = $1)',
      [userId]
    );
    
    return {
      user: userResult.rows[0],
      accounts: accountsResult.rows,
      transactions: transactionsResult.rows,
    };
  }, { readOnly: true });
}

// Example 7: Serializable transaction for critical operations
export async function processPaymentExample(
  pool: Pool,
  orderId: string,
  paymentAmount: number
) {
  return withTransaction(pool, async (client) => {
    // Lock order for update
    const orderResult = await client.query(
      'SELECT * FROM orders WHERE id = $1 FOR UPDATE',
      [orderId]
    );
    
    const order = orderResult.rows[0];
    
    if (order.status !== 'pending') {
      throw new Error('Order is not in pending status');
    }
    
    if (order.total !== paymentAmount) {
      throw new Error('Payment amount mismatch');
    }
    
    // Update order status
    await client.query(
      'UPDATE orders SET status = $1, paid_at = NOW() WHERE id = $2',
      ['paid', orderId]
    );
    
    // Record payment
    await client.query(
      'INSERT INTO payments (order_id, amount, created_at) VALUES ($1, $2, NOW())',
      [orderId, paymentAmount]
    );
    
    return { success: true, orderId };
  }, { isolationLevel: 'SERIALIZABLE' });
}
