# Metrics and Logging - Quick Start Guide

## Installation

The metrics and logging system is already integrated into the Revora Backend. No additional installation required.

## Basic Usage

### Logging

```typescript
import { globalLogger } from './lib/logger';

// Simple logging
globalLogger.info('User logged in', { userId: '123' });
globalLogger.error('Database error', { error: dbError });
globalLogger.warn('Slow query detected', { duration: 1500 });

// With context
globalLogger.setContext({ requestId: 'req-abc-123' });
globalLogger.info('Processing request'); // Includes requestId

// Child logger
const authLogger = globalLogger.child({ module: 'auth' });
authLogger.info('Authentication attempt');
```

### Metrics

```typescript
import { globalMetrics } from './lib/metrics';

// Counter
globalMetrics.incrementCounter('api_calls', { endpoint: '/users' });

// Gauge
globalMetrics.setGauge('queue_size', 42);

// Histogram
globalMetrics.recordHistogram('query_duration_ms', 125.3);

// Get snapshot
const snapshot = await globalMetrics.getSnapshot(dbPool);
console.log(snapshot);
```

### Health Checks

```typescript
// Already integrated in src/index.ts

// Endpoints:
// GET /health/live      - Liveness probe
// GET /health/ready     - Readiness probe
// GET /health/metrics   - Metrics snapshot
```

## Configuration

### Environment Variables

```bash
# .env file
LOG_LEVEL=info                    # debug, info, warn, error
NODE_ENV=production               # production, development, test
STELLAR_HORIZON_URL=https://...   # Stellar Horizon endpoint
```

### Code Configuration

```typescript
import { MetricsCollector } from './lib/metrics';
import { Logger, LogLevel } from './lib/logger';

// Custom metrics
const metrics = new MetricsCollector({
  enabled: true,
  maxPoints: 10000,
});

// Custom logger
const logger = new Logger({
  level: LogLevel.INFO,
  pretty: false,
});
```

## Testing

```bash
# Run all tests
npm test

# Run specific tests
npm test -- src/lib/metrics.test.ts
npm test -- src/lib/logger.test.ts
npm test -- src/routes/health.test.ts

# With coverage
npm test -- --coverage
```

## Kubernetes Deployment

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: revora-backend
spec:
  containers:
  - name: api
    image: revora-backend:latest
    livenessProbe:
      httpGet:
        path: /health/live
        port: 3000
      initialDelaySeconds: 10
      periodSeconds: 30
    readinessProbe:
      httpGet:
        path: /health/ready
        port: 3000
      initialDelaySeconds: 5
      periodSeconds: 10
```

## Prometheus Integration

```yaml
scrape_configs:
  - job_name: 'revora-backend'
    static_configs:
      - targets: ['revora-backend:3000']
    metrics_path: '/metrics/prometheus'
    scrape_interval: 15s
```

## Common Patterns

### Request Logging

```typescript
app.get('/api/users', async (req, res) => {
  const logger = globalLogger.child({ requestId: (req as any).requestId });
  
  logger.info('Fetching users');
  
  try {
    const users = await fetchUsers();
    logger.info('Users fetched', { count: users.length });
    res.json(users);
  } catch (error) {
    logger.error('Failed to fetch users', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

### Custom Metrics

```typescript
// Track business metrics
globalMetrics.incrementCounter('investments_created', { offering: 'ABC' });
globalMetrics.setGauge('total_investment_value', 1000000);
globalMetrics.recordHistogram('investment_amount', 5000);
```

### Error Tracking

```typescript
try {
  await riskyOperation();
} catch (error) {
  globalLogger.error('Operation failed', { error, operation: 'riskyOperation' });
  globalMetrics.incrementCounter('errors_total', { type: 'operation_failure' });
  throw error;
}
```

## Troubleshooting

### Logs not appearing
- Check `LOG_LEVEL` environment variable
- Verify logger is imported correctly
- Check console output

### Metrics not collected
- Verify metrics middleware is installed
- Check `/metrics` endpoint
- Ensure `METRICS_ENABLED=true`

### Health checks failing
- Check database connectivity
- Verify Stellar Horizon URL
- Check network connectivity

## Best Practices

1. **Use appropriate log levels**
   - ERROR: Errors that need attention
   - WARN: Warnings that should be investigated
   - INFO: Significant events
   - DEBUG: Detailed debugging information

2. **Include context in logs**
   - Always include requestId for correlation
   - Include userId for audit trail
   - Add relevant business context

3. **Keep metric cardinality low**
   - Avoid user IDs in labels
   - Use status classes (2xx, 4xx, 5xx) instead of exact codes
   - Normalize route paths

4. **Monitor key metrics**
   - HTTP request rate and latency
   - Error rate
   - Database connection pool
   - Memory usage

## Support

For detailed documentation, see:
- [Full Documentation](./metrics-and-logging-baseline.md)
- [Implementation Summary](./IMPLEMENTATION_SUMMARY.md)

---

**Quick Start Version**: 1.0.0  
**Last Updated**: 2024-03-26
