/**
 * Integration examples showing how to refactor existing code to use transactions
 * These examples demonstrate real-world patterns from the Revora backend
 */

import { Pool, PoolClient } from 'pg';
import { withTransaction } from './transaction';

/**
 * Example 1: Investment creation with audit logging
 * Before: Two separate queries that could fail independently
 * After: Atomic transaction ensures both succeed or both fail
 */
export class InvestmentService {
  constructor(private pool: Pool) {}
  
  async createInvestment(input: {
    investor_id: string;
    offering_id: string;
    amount: string;
    asset: string;
  }) {
    return withTransaction(this.pool, async (client) => {
      // Create investment
      const investmentResult = await client.query(
        `INSERT INTO investments (investor_id, offering_id, amount, asset, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'pending', NOW(), NOW())
         RETURNING *`,
        [input.investor_id, input.offering_id, input.amount, input.asset]
      );
      
      const investment = investmentResult.rows[0];
      
      // Create audit log atomically
      await client.query(
        `INSERT INTO audit_logs (action, entity_type, entity_id, user_id, details, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        ['INVESTMENT_CREATED', 'investment', investment.id, input.investor_id, JSON.stringify(input)]
      );
      
      return investment;
    });
  }
}

/**
 * Example 2: Distribution run with multiple payouts
 * Ensures all payouts are created atomically with the distribution run
 */
export class DistributionService {
  constructor(private pool: Pool) {}
  
  async createDistributionWithPayouts(input: {
    offering_id: string;
    total_amount: string;
    distribution_date: Date;
    payouts: Array<{ investor_id: string; amount: string }>;
  }) {
    return withTransaction(this.pool, async (client) => {
      // Create distribution run
      const runResult = await client.query(
        `INSERT INTO distribution_runs (offering_id, total_amount, distribution_date, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'pending', NOW(), NOW())
         RETURNING *`,
        [input.offering_id, input.total_amount, input.distribution_date]
      );
      
      const distributionRun = runResult.rows[0];
      
      // Create all payouts atomically
      for (const payout of input.payouts) {
        await client.query(
          `INSERT INTO payouts (distribution_run_id, investor_id, amount, status, created_at, updated_at)
           VALUES ($1, $2, $3, 'pending', NOW(), NOW())`,
          [distributionRun.id, payout.investor_id, payout.amount]
        );
      }
      
      return {
        distributionRun,
        payoutsCreated: input.payouts.length,
      };
    });
  }
}

/**
 * Example 3: Balance snapshot creation with consistency checks
 * Ensures snapshot is only created if validation passes
 */
export class BalanceSnapshotService {
  constructor(private pool: Pool) {}
  
  async createSnapshotWithValidation(input: {
    offering_id: string;
    period_id: string;
    snapshots: Array<{
      holder_address_or_id: string;
      balance: string;
    }>;
  }) {
    return withTransaction(this.pool, async (client) => {
      // Validate offering exists
      const offeringResult = await client.query(
        'SELECT id, status FROM offerings WHERE id = $1 FOR UPDATE',
        [input.offering_id]
      );
      
      if (offeringResult.rows.length === 0) {
        throw new Error('Offering not found');
      }
      
      if (offeringResult.rows[0].status !== 'active') {
        throw new Error('Offering is not active');
      }
      
      // Create snapshots atomically
      const createdSnapshots = [];
      for (const snapshot of input.snapshots) {
        const result = await client.query(
          `INSERT INTO token_balance_snapshots 
           (offering_id, period_id, holder_address_or_id, balance, snapshot_at, created_at)
           VALUES ($1, $2, $3, $4, NOW(), NOW())
           RETURNING *`,
          [input.offering_id, input.period_id, snapshot.holder_address_or_id, snapshot.balance]
        );
        createdSnapshots.push(result.rows[0]);
      }
      
      // Update offering last_snapshot_at
      await client.query(
        'UPDATE offerings SET last_snapshot_at = NOW() WHERE id = $1',
        [input.offering_id]
      );
      
      return createdSnapshots;
    });
  }
}

/**
 * Example 4: User registration with idempotency
 * Prevents duplicate registrations and ensures profile is created atomically
 */
export class RegistrationService {
  constructor(private pool: Pool) {}
  
  async registerUser(input: {
    email: string;
    password_hash: string;
    name: string;
    idempotency_key: string;
  }) {
    return withTransaction(this.pool, async (client) => {
      // Check idempotency key
      const idempotencyResult = await client.query(
        'SELECT response FROM idempotency_keys WHERE key = $1',
        [input.idempotency_key]
      );
      
      if (idempotencyResult.rows.length > 0) {
        // Return cached response
        return JSON.parse(idempotencyResult.rows[0].response);
      }
      
      // Create user
      const userResult = await client.query(
        `INSERT INTO users (email, password_hash, name, role, created_at, updated_at)
         VALUES ($1, $2, $3, 'investor', NOW(), NOW())
         RETURNING id, email, name, role, created_at`,
        [input.email, input.password_hash, input.name]
      );
      
      const user = userResult.rows[0];
      
      // Create notification preferences
      await client.query(
        `INSERT INTO notification_preferences (user_id, email_enabled, created_at, updated_at)
         VALUES ($1, true, NOW(), NOW())`,
        [user.id]
      );
      
      // Store idempotency key
      await client.query(
        `INSERT INTO idempotency_keys (key, response, created_at)
         VALUES ($1, $2, NOW())`,
        [input.idempotency_key, JSON.stringify(user)]
      );
      
      return user;
    });
  }
}

/**
 * Example 5: Revenue reconciliation with locking
 * Ensures consistent reads and prevents concurrent modifications
 */
export class RevenueReconciliationService {
  constructor(private pool: Pool) {}
  
  async reconcileAndDistribute(input: {
    offering_id: string;
    period_start: Date;
    period_end: Date;
  }) {
    return withTransaction(this.pool, async (client) => {
      // Lock offering for update
      const offeringResult = await client.query(
        'SELECT * FROM offerings WHERE id = $1 FOR UPDATE',
        [input.offering_id]
      );
      
      if (offeringResult.rows.length === 0) {
        throw new Error('Offering not found');
      }
      
      // Get revenue reports
      const revenueResult = await client.query(
        `SELECT SUM(amount) as total_revenue
         FROM revenue_reports
         WHERE offering_id = $1
           AND period_start >= $2
           AND period_end <= $3`,
        [input.offering_id, input.period_start, input.period_end]
      );
      
      const totalRevenue = revenueResult.rows[0].total_revenue || '0';
      
      // Get existing distributions
      const distributionResult = await client.query(
        `SELECT SUM(total_amount) as total_distributed
         FROM distribution_runs
         WHERE offering_id = $1
           AND distribution_date >= $2
           AND distribution_date <= $3
           AND status = 'completed'`,
        [input.offering_id, input.period_start, input.period_end]
      );
      
      const totalDistributed = distributionResult.rows[0].total_distributed || '0';
      
      // Calculate undistributed amount
      const undistributed = parseFloat(totalRevenue) - parseFloat(totalDistributed);
      
      if (undistributed <= 0) {
        return {
          offering_id: input.offering_id,
          total_revenue: totalRevenue,
          total_distributed: totalDistributed,
          undistributed: '0',
          distribution_created: false,
        };
      }
      
      // Create new distribution run
      const newDistributionResult = await client.query(
        `INSERT INTO distribution_runs (offering_id, total_amount, distribution_date, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'pending', NOW(), NOW())
         RETURNING *`,
        [input.offering_id, undistributed.toString(), input.period_end]
      );
      
      return {
        offering_id: input.offering_id,
        total_revenue: totalRevenue,
        total_distributed: totalDistributed,
        undistributed: undistributed.toString(),
        distribution_created: true,
        distribution_run: newDistributionResult.rows[0],
      };
    }, { isolationLevel: 'REPEATABLE READ' });
  }
}

/**
 * Example 6: Webhook endpoint registration with validation
 * Ensures endpoint is validated before being stored
 */
export class WebhookService {
  constructor(private pool: Pool) {}
  
  async registerEndpoint(input: {
    user_id: string;
    url: string;
    events: string[];
    secret: string;
  }) {
    return withTransaction(this.pool, async (client) => {
      // Validate user exists
      const userResult = await client.query(
        'SELECT id FROM users WHERE id = $1',
        [input.user_id]
      );
      
      if (userResult.rows.length === 0) {
        throw new Error('User not found');
      }
      
      // Check for duplicate URL
      const duplicateResult = await client.query(
        'SELECT id FROM webhook_endpoints WHERE user_id = $1 AND url = $2',
        [input.user_id, input.url]
      );
      
      if (duplicateResult.rows.length > 0) {
        throw new Error('Webhook endpoint already registered');
      }
      
      // Create webhook endpoint
      const endpointResult = await client.query(
        `INSERT INTO webhook_endpoints (user_id, url, events, secret, enabled, created_at, updated_at)
         VALUES ($1, $2, $3, $4, true, NOW(), NOW())
         RETURNING *`,
        [input.user_id, input.url, JSON.stringify(input.events), input.secret]
      );
      
      // Log webhook registration
      await client.query(
        `INSERT INTO audit_logs (action, entity_type, entity_id, user_id, details, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        ['WEBHOOK_REGISTERED', 'webhook_endpoint', endpointResult.rows[0].id, input.user_id, JSON.stringify({ url: input.url, events: input.events })]
      );
      
      return endpointResult.rows[0];
    });
  }
}

/**
 * Example 7: Notification creation with fan-out
 * Creates notification and sends to all relevant users atomically
 */
export class NotificationService {
  constructor(private pool: Pool) {}
  
  async createAndFanOut(input: {
    offering_id: string;
    event_type: string;
    message: string;
  }) {
    return withTransaction(this.pool, async (client) => {
      // Get all investors for this offering
      const investorsResult = await client.query(
        `SELECT DISTINCT investor_id
         FROM investments
         WHERE offering_id = $1 AND status = 'completed'`,
        [input.offering_id]
      );
      
      if (investorsResult.rows.length === 0) {
        return { notifications_created: 0 };
      }
      
      // Create notifications for all investors
      const notifications = [];
      for (const row of investorsResult.rows) {
        // Check user preferences
        const prefsResult = await client.query(
          'SELECT email_enabled FROM notification_preferences WHERE user_id = $1',
          [row.investor_id]
        );
        
        if (prefsResult.rows.length === 0 || !prefsResult.rows[0].email_enabled) {
          continue;
        }
        
        // Create notification
        const notificationResult = await client.query(
          `INSERT INTO notifications (user_id, type, message, read, created_at)
           VALUES ($1, $2, $3, false, NOW())
           RETURNING *`,
          [row.investor_id, input.event_type, input.message]
        );
        
        notifications.push(notificationResult.rows[0]);
      }
      
      return {
        notifications_created: notifications.length,
        notifications,
      };
    });
  }
}
