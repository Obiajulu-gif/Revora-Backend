# Metrics and Logging - Next Steps

## Test Results Summary

**Status**: Partial Success
- ✅ 10 test suites passed (126 tests)
- ❌ 30 test suites failed (TypeScript compilation errors)
- ❌ 2 tests failed (logic errors)

### Passing Test Suites
1. webhookService.test.ts
2. vaults/milestoneValidationRoute.test.ts
3. offerings/revenueReportsRoute.test.ts
4. services/offeringSyncService.test.ts
5. db/repositories/revenueReportRepository.test.ts
6. db/repositories/balanceSnapshotRepository.test.ts
7. lib/pagination.test.ts
8. services/startupAuthService.test.ts
9. offerings/offeringService.test.ts
10. middleware/idempotency.test.ts

### Critical Fixes Needed

#### 1. Metrics Test Failures
**File**: `src/lib/metrics.test.ts`
**Issue**: Metric key parsing with empty labels
```typescript
// Expected: "metric"
// Received: "metric{}"
```
**Fix**: Update `parseMetricKey` method to handle empty label objects

#### 2. Logger Test Failures
**File**: `src/lib/logger.test.ts`
**Issues**:
- Missing properties on LogEntry interface (service, version, module, child)
- Type safety issues with context properties

**Fix**: Update LogEntry interface to include dynamic context properties

#### 3. Health Check Test Failures
**File**: `src/routes/health.test.ts`
**Issue**: Cannot assign to read-only Pool properties
**Fix**: Use proper mocking strategy for Pool interface

#### 4. TypeScript Configuration Issues
**File**: `src/lib/errors.test.ts`
**Issue**: `Object.hasOwn` requires ES2022 lib
**Fix**: Update tsconfig.json to include ES2022

## 2. Additional Features & Enhancements

### High Priority

#### A. Distributed Tracing Integration
**Goal**: Add OpenTelemetry support for distributed tracing

**Implementation**:
```typescript
// src/lib/tracing.ts
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';

export class TracingService {
  private tracer: Tracer;
  
  constructor(serviceName: string) {
    const provider = new NodeTracerProvider();
    const exporter = new JaegerExporter({
      endpoint: process.env.JAEGER_ENDPOINT
    });
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();
    this.tracer = trace.getTracer(serviceName);
  }
  
  startSpan(name: string, attributes?: Record<string, any>) {
    return this.tracer.startSpan(name, { attributes });
  }
}
```

**Integration Points**:
- HTTP middleware for automatic span creation
- Database query tracing
- External API call tracing
- Correlation with logs via trace IDs

#### B. Custom Business Metrics
**Goal**: Add domain-specific metrics for Revora platform

**Metrics to Add**:
```typescript
// Investment metrics
metrics.incrementCounter('investments_created_total', { offering_id });
metrics.setGauge('total_investment_value_usd', totalValue);
metrics.recordHistogram('investment_amount_usd', amount);

// Revenue metrics
metrics.incrementCounter('revenue_reports_processed_total', { offering_id });
metrics.recordHistogram('revenue_distribution_duration_ms', duration);

// Stellar blockchain metrics
metrics.incrementCounter('stellar_transactions_total', { type, status });
metrics.recordHistogram('stellar_transaction_latency_ms', latency);
metrics.setGauge('stellar_account_balance_xlm', balance);

// User metrics
metrics.incrementCounter('user_registrations_total', { role });
metrics.setGauge('active_users_count', count, { role });
```

**Implementation**:
1. Create `src/lib/businessMetrics.ts` with typed metric helpers
2. Integrate into service layers
3. Add Grafana dashboard templates

#### C. Log Aggregation Setup
**Goal**: Configure log shipping to centralized system

**Options**:
1. **ELK Stack** (Elasticsearch, Logstash, Kibana)
2. **AWS CloudWatch Logs**
3. **Datadog**
4. **Splunk**

**Implementation** (CloudWatch example):
```typescript
// src/lib/logShipper.ts
import { CloudWatchLogs } from '@aws-sdk/client-cloudwatch-logs';

export class CloudWatchLogShipper {
  private client: CloudWatchLogs;
  private logGroupName: string;
  private logStreamName: string;
  
  async shipLogs(logs: LogEntry[]) {
    const events = logs.map(log => ({
      message: JSON.stringify(log),
      timestamp: new Date(log.timestamp).getTime()
    }));
    
    await this.client.putLogEvents({
      logGroupName: this.logGroupName,
      logStreamName: this.logStreamName,
      logEvents: events
    });
  }
}
```

#### D. Alerting Rules
**Goal**: Define alerting thresholds and notification channels

**Prometheus Alert Rules**:
```yaml
# alerts/revora-backend.yml
groups:
  - name: revora_backend_alerts
    interval: 30s
    rules:
      - alert: HighErrorRate
        expr: rate(errors_total[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High error rate detected"
          description: "Error rate is {{ $value }} errors/sec"
      
      - alert: HighLatency
        expr: histogram_quantile(0.95, http_request_duration_ms) > 2000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High API latency"
          description: "P95 latency is {{ $value }}ms"
      
      - alert: DatabasePoolExhausted
        expr: database_waiting_count > 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Database connection pool exhausted"
      
      - alert: MemoryUsageHigh
        expr: (system_memory_usage_heap_used / system_memory_usage_heap_total) > 0.85
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High memory usage"
```

**Notification Channels**:
- Slack webhook integration
- PagerDuty for critical alerts
- Email for warnings

### Medium Priority

#### E. Performance Profiling
**Goal**: Add CPU and memory profiling capabilities

```typescript
// src/lib/profiler.ts
import v8Profiler from 'v8-profiler-next';
import heapdump from 'heapdump';

export class Profiler {
  startCPUProfile(name: string) {
    v8Profiler.startProfiling(name, true);
  }
  
  stopCPUProfile(name: string) {
    const profile = v8Profiler.stopProfiling(name);
    profile.export((error, result) => {
      fs.writeFileSync(`./profiles/${name}.cpuprofile`, result);
      profile.delete();
    });
  }
  
  takeHeapSnapshot(name: string) {
    heapdump.writeSnapshot(`./profiles/${name}.heapsnapshot`);
  }
}
```

#### F. Grafana Dashboards
**Goal**: Create pre-built dashboards for common metrics

**Dashboards to Create**:
1. **System Overview**
   - Request rate, error rate, latency
   - Memory and CPU usage
   - Active connections

2. **Database Performance**
   - Connection pool statistics
   - Query latency
   - Slow query log

3. **Business Metrics**
   - Investment volume
   - Revenue distribution stats
   - User activity

4. **Stellar Integration**
   - Transaction success rate
   - Blockchain latency
   - Account balances

## 3. Integration into Application

### Current Integration Status
✅ Metrics middleware installed in `src/index.ts`
✅ Health check routes configured
✅ Logger integrated globally
⚠️ Need to add metrics to business logic

### Integration Tasks

#### A. Add Metrics to Investment Flow
```typescript
// src/routes/investments.ts
export async function createInvestment(req, res) {
  const startTime = Date.now();
  
  try {
    globalMetrics.incrementCounter('investments_started_total', {
      offering_id: req.body.offering_id
    });
    
    const investment = await investmentService.create(req.body);
    
    globalMetrics.incrementCounter('investments_created_total', {
      offering_id: req.body.offering_id,
      status: 'success'
    });
    
    globalMetrics.recordHistogram(
      'investment_creation_duration_ms',
      Date.now() - startTime,
      { offering_id: req.body.offering_id }
    );
    
    res.json(investment);
  } catch (error) {
    globalMetrics.incrementCounter('investments_created_total', {
      offering_id: req.body.offering_id,
      status: 'failed'
    });
    throw error;
  }
}
```

#### B. Add Metrics to Revenue Distribution
```typescript
// src/services/distributionEngine.ts
export class DistributionEngine {
  async distributeRevenue(reportId: string) {
    const startTime = Date.now();
    
    try {
      globalMetrics.incrementCounter('revenue_distributions_started_total', {
        report_id: reportId
      });
      
      const result = await this.processDistribution(reportId);
      
      globalMetrics.incrementCounter('revenue_distributions_completed_total', {
        report_id: reportId,
        status: 'success'
      });
      
      globalMetrics.recordHistogram(
        'revenue_distribution_duration_ms',
        Date.now() - startTime
      );
      
      globalMetrics.setGauge(
        'last_distribution_amount_usd',
        result.totalAmount
      );
      
      return result;
    } catch (error) {
      globalMetrics.incrementCounter('revenue_distributions_completed_total', {
        report_id: reportId,
        status: 'failed'
      });
      throw error;
    }
  }
}
```

#### C. Add Metrics to Stellar Operations
```typescript
// src/lib/stellar.ts
export class HorizonClient {
  async submitTransaction(tx: Transaction) {
    const startTime = Date.now();
    
    try {
      globalMetrics.incrementCounter('stellar_transactions_submitted_total', {
        type: tx.operations[0].type
      });
      
      const result = await this.server.submitTransaction(tx);
      
      globalMetrics.incrementCounter('stellar_transactions_completed_total', {
        type: tx.operations[0].type,
        status: 'success'
      });
      
      globalMetrics.recordHistogram(
        'stellar_transaction_latency_ms',
        Date.now() - startTime
      );
      
      return result;
    } catch (error) {
      globalMetrics.incrementCounter('stellar_transactions_completed_total', {
        type: tx.operations[0].type,
        status: 'failed'
      });
      throw error;
    }
  }
}
```

## 4. Deployment Configuration

### Kubernetes Deployment

#### A. Update Deployment Manifest
```yaml
# k8s/deployment.yml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: revora-backend
  labels:
    app: revora-backend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: revora-backend
  template:
    metadata:
      labels:
        app: revora-backend
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "3000"
        prometheus.io/path: "/metrics/prometheus"
    spec:
      containers:
      - name: api
        image: revora-backend:latest
        ports:
        - containerPort: 3000
          name: http
        env:
        - name: LOG_LEVEL
          value: "info"
        - name: NODE_ENV
          value: "production"
        - name: METRICS_ENABLED
          value: "true"
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health/live
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 30
          timeoutSeconds: 5
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 10
          timeoutSeconds: 5
```

#### B. Service Configuration
```yaml
# k8s/service.yml
apiVersion: v1
kind: Service
metadata:
  name: revora-backend
  labels:
    app: revora-backend
spec:
  type: ClusterIP
  ports:
  - port: 80
    targetPort: 3000
    protocol: TCP
    name: http
  selector:
    app: revora-backend
```

#### C. ServiceMonitor for Prometheus
```yaml
# k8s/servicemonitor.yml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: revora-backend
  labels:
    app: revora-backend
spec:
  selector:
    matchLabels:
      app: revora-backend
  endpoints:
  - port: http
    path: /metrics/prometheus
    interval: 15s
```

### Docker Configuration

#### A. Production Dockerfile
```dockerfile
# Dockerfile.prod
FROM node:18-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

FROM node:18-alpine

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV METRICS_ENABLED=true

EXPOSE 3000

USER node

CMD ["node", "dist/index.js"]
```

### Environment Variables

```bash
# Production .env
NODE_ENV=production
LOG_LEVEL=info
METRICS_ENABLED=true

# Database
DATABASE_URL=postgresql://user:pass@host:5432/revora

# Stellar
STELLAR_HORIZON_URL=https://horizon.stellar.org
STELLAR_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015

# Observability
JAEGER_ENDPOINT=http://jaeger:14268/api/traces
CLOUDWATCH_LOG_GROUP=/aws/revora/backend
CLOUDWATCH_LOG_STREAM=production

# Alerting
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx
PAGERDUTY_API_KEY=xxx
```

## 5. Custom Metrics for Business Logic

### Investment Metrics

```typescript
// src/metrics/investmentMetrics.ts
import { globalMetrics } from '../lib/metrics';

export class InvestmentMetrics {
  // Track investment creation
  static recordInvestmentCreated(investment: Investment) {
    globalMetrics.incrementCounter('investments_created_total', {
      offering_id: investment.offering_id,
      investor_role: investment.investor_role
    });
    
    globalMetrics.recordHistogram(
      'investment_amount_usd',
      investment.amount_usd,
      { offering_id: investment.offering_id }
    );
  }
  
  // Track investment status changes
  static recordStatusChange(investmentId: string, from: string, to: string) {
    globalMetrics.incrementCounter('investment_status_changes_total', {
      from_status: from,
      to_status: to
    });
  }
  
  // Track total investment value
  static updateTotalInvestmentValue(offeringId: string, totalValue: number) {
    globalMetrics.setGauge(
      'offering_total_investment_usd',
      totalValue,
      { offering_id: offeringId }
    );
  }
  
  // Track investor count
  static updateInvestorCount(offeringId: string, count: number) {
    globalMetrics.setGauge(
      'offering_investor_count',
      count,
      { offering_id: offeringId }
    );
  }
}
```

### Revenue Metrics

```typescript
// src/metrics/revenueMetrics.ts
export class RevenueMetrics {
  // Track revenue report processing
  static recordReportProcessed(report: RevenueReport) {
    globalMetrics.incrementCounter('revenue_reports_processed_total', {
      offering_id: report.offering_id,
      status: report.status
    });
    
    globalMetrics.recordHistogram(
      'revenue_report_amount_usd',
      report.amount_usd,
      { offering_id: report.offering_id }
    );
  }
  
  // Track distribution execution
  static recordDistributionStarted(runId: string, offeringId: string) {
    globalMetrics.incrementCounter('revenue_distributions_started_total', {
      offering_id: offeringId
    });
  }
  
  static recordDistributionCompleted(
    runId: string,
    offeringId: string,
    duration: number,
    payoutCount: number,
    totalAmount: number
  ) {
    globalMetrics.incrementCounter('revenue_distributions_completed_total', {
      offering_id: offeringId,
      status: 'success'
    });
    
    globalMetrics.recordHistogram(
      'revenue_distribution_duration_ms',
      duration,
      { offering_id: offeringId }
    );
    
    globalMetrics.setGauge(
      'last_distribution_payout_count',
      payoutCount,
      { offering_id: offeringId }
    );
    
    globalMetrics.setGauge(
      'last_distribution_amount_usd',
      totalAmount,
      { offering_id: offeringId }
    );
  }
  
  static recordDistributionFailed(runId: string, offeringId: string, error: Error) {
    globalMetrics.incrementCounter('revenue_distributions_completed_total', {
      offering_id: offeringId,
      status: 'failed',
      error_type: error.name
    });
  }
}
```

### Stellar Metrics

```typescript
// src/metrics/stellarMetrics.ts
export class StellarMetrics {
  // Track transaction submissions
  static recordTransactionSubmitted(type: string) {
    globalMetrics.incrementCounter('stellar_transactions_submitted_total', {
      operation_type: type
    });
  }
  
  static recordTransactionCompleted(
    type: string,
    success: boolean,
    latency: number
  ) {
    globalMetrics.incrementCounter('stellar_transactions_completed_total', {
      operation_type: type,
      status: success ? 'success' : 'failed'
    });
    
    globalMetrics.recordHistogram(
      'stellar_transaction_latency_ms',
      latency,
      { operation_type: type }
    );
  }
  
  // Track account balances
  static updateAccountBalance(accountId: string, balance: number, asset: string) {
    globalMetrics.setGauge(
      'stellar_account_balance',
      balance,
      { account_id: accountId, asset }
    );
  }
  
  // Track Horizon API calls
  static recordHorizonAPICall(endpoint: string, statusCode: number, latency: number) {
    globalMetrics.incrementCounter('stellar_horizon_api_calls_total', {
      endpoint,
      status_code: statusCode.toString()
    });
    
    globalMetrics.recordHistogram(
      'stellar_horizon_api_latency_ms',
      latency,
      { endpoint }
    );
  }
}
```

### User Metrics

```typescript
// src/metrics/userMetrics.ts
export class UserMetrics {
  // Track user registrations
  static recordUserRegistered(role: string) {
    globalMetrics.incrementCounter('user_registrations_total', {
      role
    });
  }
  
  // Track active users
  static updateActiveUserCount(role: string, count: number) {
    globalMetrics.setGauge(
      'active_users_count',
      count,
      { role }
    });
  }
  
  // Track authentication
  static recordLoginAttempt(success: boolean, role?: string) {
    globalMetrics.incrementCounter('user_login_attempts_total', {
      status: success ? 'success' : 'failed',
      role: role || 'unknown'
    });
  }
  
  // Track session duration
  static recordSessionDuration(duration: number, role: string) {
    globalMetrics.recordHistogram(
      'user_session_duration_seconds',
      duration / 1000,
      { role }
    );
  }
}
```

## Implementation Priority

### Phase 1: Critical Fixes (Week 1)
1. Fix failing tests (TypeScript errors)
2. Fix metrics parsing bug
3. Update logger interface
4. Fix health check mocks

### Phase 2: Core Enhancements (Week 2-3)
1. Add business metrics to all services
2. Create Grafana dashboards
3. Set up alerting rules
4. Configure log aggregation

### Phase 3: Advanced Features (Week 4-5)
1. Implement distributed tracing
2. Add performance profiling
3. Create deployment configurations
4. Set up monitoring infrastructure

### Phase 4: Documentation & Training (Week 6)
1. Update documentation
2. Create runbooks for common issues
3. Train team on observability tools
4. Conduct load testing with metrics

## Success Metrics

- ✅ All tests passing (40/40 suites)
- ✅ 95%+ test coverage maintained
- ✅ Metrics collection overhead < 1ms per request
- ✅ Log aggregation latency < 5 seconds
- ✅ Alert response time < 5 minutes
- ✅ Dashboard load time < 2 seconds
- ✅ Zero PII in logs or metrics

## Resources Needed

### Infrastructure
- Prometheus server (or managed service)
- Grafana instance
- Log aggregation system (ELK/CloudWatch/Datadog)
- Jaeger for distributed tracing (optional)

### Team
- DevOps engineer for infrastructure setup
- Backend developers for metric integration
- SRE for alerting and runbook creation

### Budget Estimate
- Managed Prometheus: $50-200/month
- Grafana Cloud: $0-100/month (depending on usage)
- Log aggregation: $100-500/month
- Distributed tracing: $50-200/month
- **Total**: $200-1000/month depending on scale

---

**Last Updated**: 2024-03-26
**Status**: In Progress
**Owner**: Platform Team
