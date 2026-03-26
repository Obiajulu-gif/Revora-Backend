/**
 * Metrics Collection and Aggregation Service
 * 
 * Provides production-grade metrics collection for monitoring application health,
 * performance, and resource utilization. Metrics are stored in-memory with
 * configurable retention and can be exported for external monitoring systems.
 * 
 * Security Assumptions:
 * - Metrics endpoints should be protected or rate-limited in production
 * - Sensitive data (PII, credentials) must never be included in metric labels
 * - Metric names and labels are sanitized to prevent injection attacks
 * 
 * @module lib/metrics
 */

import { Pool } from 'pg';

/**
 * Supported metric types following industry standards (Prometheus-style)
 */
export enum MetricType {
  /** Monotonically increasing counter (e.g., total requests) */
  COUNTER = 'counter',
  /** Point-in-time measurement (e.g., memory usage) */
  GAUGE = 'gauge',
  /** Statistical distribution (e.g., request duration) */
  HISTOGRAM = 'histogram',
}

/**
 * Metric data point with timestamp and labels
 */
export interface MetricPoint {
  /** Metric identifier */
  name: string;
  /** Metric type */
  type: MetricType;
  /** Numeric value */
  value: number;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Key-value labels for dimensional data */
  labels?: Record<string, string>;
  /** Human-readable description */
  help?: string;
}

/**
 * Histogram bucket for distribution metrics
 */
export interface HistogramBucket {
  /** Upper bound of bucket (inclusive) */
  le: number;
  /** Count of observations <= le */
  count: number;
}

/**
 * Aggregated histogram data
 */
export interface HistogramData {
  /** Total count of observations */
  count: number;
  /** Sum of all observed values */
  sum: number;
  /** Distribution buckets */
  buckets: HistogramBucket[];
}

/**
 * System resource metrics
 */
export interface SystemMetrics {
  /** Memory usage in bytes */
  memoryUsage: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  };
  /** CPU usage percentage (0-100) */
  cpuUsage: {
    user: number;
    system: number;
  };
  /** Process uptime in seconds */
  uptime: number;
}

/**
 * Database connection pool metrics
 */
export interface DatabaseMetrics {
  /** Total connections in pool */
  totalCount: number;
  /** Idle connections available */
  idleCount: number;
  /** Connections currently in use */
  activeCount: number;
  /** Connections waiting to be acquired */
  waitingCount: number;
}

/**
 * Application-level metrics summary
 */
export interface ApplicationMetrics {
  /** HTTP request metrics by status code */
  httpRequests: Record<string, number>;
  /** HTTP request duration histogram */
  httpDuration: HistogramData;
  /** Active HTTP connections */
  activeConnections: number;
  /** Error count by type */
  errors: Record<string, number>;
}

/**
 * Complete metrics snapshot
 */
export interface MetricsSnapshot {
  /** Snapshot timestamp */
  timestamp: string;
  /** System resource metrics */
  system: SystemMetrics;
  /** Database metrics */
  database: DatabaseMetrics | null;
  /** Application metrics */
  application: ApplicationMetrics;
  /** Custom metric points */
  custom: MetricPoint[];
}

/**
 * Configuration for metrics collection
 */
export interface MetricsConfig {
  /** Enable/disable metrics collection */
  enabled: boolean;
  /** Maximum number of metric points to retain in memory */
  maxPoints: number;
  /** Histogram bucket boundaries (in milliseconds for duration) */
  histogramBuckets: number[];
}

/**
 * Default histogram buckets for HTTP request duration (in milliseconds)
 * Covers typical API response times: 10ms to 30s
 */
const DEFAULT_HISTOGRAM_BUCKETS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

/**
 * MetricsCollector - Thread-safe metrics aggregation service
 * 
 * Collects and aggregates application metrics in-memory. Designed for
 * high-throughput environments with minimal performance overhead.
 * 
 * Usage:
 * ```typescript
 * const metrics = new MetricsCollector({ enabled: true });
 * metrics.incrementCounter('http_requests_total', { method: 'GET', status: '200' });
 * metrics.recordHistogram('http_request_duration_ms', 45.2, { route: '/api/users' });
 * const snapshot = await metrics.getSnapshot(dbPool);
 * ```
 */
export class MetricsCollector {
  private config: MetricsConfig;
  private counters: Map<string, number> = new Map();
  private gauges: Map<string, number> = new Map();
  private histograms: Map<string, number[]> = new Map();
  private metricMetadata: Map<string, { type: MetricType; help?: string }> = new Map();
  private activeConnections = 0;
  private startTime: number;

  constructor(config: Partial<MetricsConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      maxPoints: config.maxPoints ?? 10000,
      histogramBuckets: config.histogramBuckets ?? DEFAULT_HISTOGRAM_BUCKETS,
    };
    this.startTime = Date.now();
  }

  /**
   * Sanitize metric name to prevent injection and ensure valid format
   * @param name Raw metric name
   * @returns Sanitized metric name
   */
  private sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_:]/g, '_');
  }

  /**
   * Sanitize label values to prevent injection
   * @param labels Raw labels
   * @returns Sanitized labels
   */
  private sanitizeLabels(labels?: Record<string, string>): Record<string, string> {
    if (!labels) return {};
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(labels)) {
      const sanitizedKey = key.replace(/[^a-zA-Z0-9_]/g, '_');
      // Remove any potential control characters or quotes
      const sanitizedValue = String(value).replace(/[\x00-\x1F\x7F"\\]/g, '');
      sanitized[sanitizedKey] = sanitizedValue;
    }
    return sanitized;
  }

  /**
   * Generate unique key for metric with labels
   * @param name Metric name
   * @param labels Metric labels
   * @returns Unique key string
   */
  private getMetricKey(name: string, labels?: Record<string, string>): string {
    const sanitizedName = this.sanitizeName(name);
    if (!labels || Object.keys(labels).length === 0) {
      return sanitizedName;
    }
    const sanitizedLabels = this.sanitizeLabels(labels);
    const labelStr = Object.entries(sanitizedLabels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    return `${sanitizedName}{${labelStr}}`;
  }

  /**
   * Increment a counter metric
   * @param name Counter name
   * @param labels Optional dimensional labels
   * @param value Increment amount (default: 1)
   * @param help Optional metric description
   */
  incrementCounter(name: string, labels?: Record<string, string>, value = 1, help?: string): void {
    if (!this.config.enabled) return;
    
    const key = this.getMetricKey(name, labels);
    const current = this.counters.get(key) ?? 0;
    this.counters.set(key, current + value);
    
    if (!this.metricMetadata.has(name)) {
      this.metricMetadata.set(name, { type: MetricType.COUNTER, help });
    }
  }

  /**
   * Set a gauge metric to a specific value
   * @param name Gauge name
   * @param value Current value
   * @param labels Optional dimensional labels
   * @param help Optional metric description
   */
  setGauge(name: string, value: number, labels?: Record<string, string>, help?: string): void {
    if (!this.config.enabled) return;
    
    const key = this.getMetricKey(name, labels);
    this.gauges.set(key, value);
    
    if (!this.metricMetadata.has(name)) {
      this.metricMetadata.set(name, { type: MetricType.GAUGE, help });
    }
  }

  /**
   * Record an observation in a histogram
   * @param name Histogram name
   * @param value Observed value
   * @param labels Optional dimensional labels
   * @param help Optional metric description
   */
  recordHistogram(name: string, value: number, labels?: Record<string, string>, help?: string): void {
    if (!this.config.enabled) return;
    
    const key = this.getMetricKey(name, labels);
    const observations = this.histograms.get(key) ?? [];
    observations.push(value);
    
    // Limit memory usage by keeping only recent observations
    if (observations.length > this.config.maxPoints) {
      observations.shift();
    }
    
    this.histograms.set(key, observations);
    
    if (!this.metricMetadata.has(name)) {
      this.metricMetadata.set(name, { type: MetricType.HISTOGRAM, help });
    }
  }

  /**
   * Increment active connection counter
   */
  incrementActiveConnections(): void {
    this.activeConnections++;
  }

  /**
   * Decrement active connection counter
   */
  decrementActiveConnections(): void {
    this.activeConnections = Math.max(0, this.activeConnections - 1);
  }

  /**
   * Calculate histogram statistics from observations
   * @param observations Array of observed values
   * @returns Aggregated histogram data
   */
  private calculateHistogram(observations: number[]): HistogramData {
    const sorted = [...observations].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, val) => acc + val, 0);
    const count = sorted.length;

    const buckets: HistogramBucket[] = this.config.histogramBuckets.map((le) => ({
      le,
      count: sorted.filter((v) => v <= le).length,
    }));

    // Add +Inf bucket
    buckets.push({ le: Infinity, count });

    return { count, sum, buckets };
  }

  /**
   * Collect system resource metrics
   * @returns System metrics snapshot
   */
  private collectSystemMetrics(): SystemMetrics {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    return {
      memoryUsage: {
        rss: memUsage.rss,
        heapTotal: memUsage.heapTotal,
        heapUsed: memUsage.heapUsed,
        external: memUsage.external,
      },
      cpuUsage: {
        user: cpuUsage.user / 1000, // Convert to milliseconds
        system: cpuUsage.system / 1000,
      },
      uptime: (Date.now() - this.startTime) / 1000, // Convert to seconds
    };
  }

  /**
   * Collect database connection pool metrics
   * @param pool PostgreSQL connection pool
   * @returns Database metrics or null if pool unavailable
   */
  private collectDatabaseMetrics(pool?: Pool): DatabaseMetrics | null {
    if (!pool) return null;

    return {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      activeCount: pool.totalCount - pool.idleCount,
      waitingCount: pool.waitingCount,
    };
  }

  /**
   * Collect application-level metrics
   * @returns Application metrics snapshot
   */
  private collectApplicationMetrics(): ApplicationMetrics {
    const httpRequests: Record<string, number> = {};
    const errorCounts: Record<string, number> = {};

    // Aggregate HTTP request counters by status code
    for (const [key, value] of this.counters.entries()) {
      if (key.startsWith('http_requests_total')) {
        const match = key.match(/status="(\d+)"/);
        if (match) {
          const status = match[1];
          httpRequests[status] = (httpRequests[status] ?? 0) + value;
        }
      }
      if (key.startsWith('errors_total')) {
        const match = key.match(/type="([^"]+)"/);
        if (match) {
          const type = match[1];
          errorCounts[type] = (errorCounts[type] ?? 0) + value;
        }
      }
    }

    // Aggregate HTTP duration histogram
    let httpDuration: HistogramData = {
      count: 0,
      sum: 0,
      buckets: this.config.histogramBuckets.map((le) => ({ le, count: 0 })),
    };

    for (const [key, observations] of this.histograms.entries()) {
      if (key.startsWith('http_request_duration_ms')) {
        httpDuration = this.calculateHistogram(observations);
        break;
      }
    }

    return {
      httpRequests,
      httpDuration,
      activeConnections: this.activeConnections,
      errors: errorCounts,
    };
  }

  /**
   * Get complete metrics snapshot
   * @param pool Optional database pool for DB metrics
   * @returns Complete metrics snapshot
   */
  async getSnapshot(pool?: Pool): Promise<MetricsSnapshot> {
    return {
      timestamp: new Date().toISOString(),
      system: this.collectSystemMetrics(),
      database: this.collectDatabaseMetrics(pool),
      application: this.collectApplicationMetrics(),
      custom: this.getCustomMetrics(),
    };
  }

  /**
   * Get all custom metrics as metric points
   * @returns Array of metric points
   */
  private getCustomMetrics(): MetricPoint[] {
    const points: MetricPoint[] = [];
    const timestamp = new Date().toISOString();

    // Export counters
    for (const [key, value] of this.counters.entries()) {
      const { name, labels } = this.parseMetricKey(key);
      const metadata = this.metricMetadata.get(name);
      points.push({
        name,
        type: MetricType.COUNTER,
        value,
        timestamp,
        labels,
        help: metadata?.help,
      });
    }

    // Export gauges
    for (const [key, value] of this.gauges.entries()) {
      const { name, labels } = this.parseMetricKey(key);
      const metadata = this.metricMetadata.get(name);
      points.push({
        name,
        type: MetricType.GAUGE,
        value,
        timestamp,
        labels,
        help: metadata?.help,
      });
    }

    return points;
  }

  /**
   * Parse metric key back into name and labels
   * @param key Metric key string
   * @returns Parsed name and labels
   */
  private parseMetricKey(key: string): { name: string; labels?: Record<string, string> } {
    const match = key.match(/^([^{]+)(?:\{(.+)\})?$/);
    if (!match) return { name: key };

    const name = match[1];
    const labelStr = match[2];

    if (!labelStr) return { name };

    const labels: Record<string, string> = {};
    const labelPairs = labelStr.match(/(\w+)="([^"]*)"/g);
    if (labelPairs) {
      for (const pair of labelPairs) {
        const [, k, v] = pair.match(/(\w+)="([^"]*)"/) ?? [];
        if (k && v !== undefined) {
          labels[k] = v;
        }
      }
    }

    return { name, labels };
  }

  /**
   * Reset all metrics (useful for testing)
   */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.metricMetadata.clear();
    this.activeConnections = 0;
  }

  /**
   * Export metrics in Prometheus text format
   * @returns Prometheus-formatted metrics string
   */
  exportPrometheus(): string {
    const lines: string[] = [];
    const timestamp = Date.now();

    // Export counters
    for (const [key, value] of this.counters.entries()) {
      const { name, labels } = this.parseMetricKey(key);
      const metadata = this.metricMetadata.get(name);
      
      if (metadata?.help) {
        lines.push(`# HELP ${name} ${metadata.help}`);
      }
      lines.push(`# TYPE ${name} counter`);
      
      const labelStr = labels ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}` : '';
      lines.push(`${name}${labelStr} ${value} ${timestamp}`);
    }

    // Export gauges
    for (const [key, value] of this.gauges.entries()) {
      const { name, labels } = this.parseMetricKey(key);
      const metadata = this.metricMetadata.get(name);
      
      if (metadata?.help) {
        lines.push(`# HELP ${name} ${metadata.help}`);
      }
      lines.push(`# TYPE ${name} gauge`);
      
      const labelStr = labels ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}` : '';
      lines.push(`${name}${labelStr} ${value} ${timestamp}`);
    }

    return lines.join('\n') + '\n';
  }
}

/**
 * Global metrics collector instance
 * Singleton pattern for application-wide metrics collection
 */
export const globalMetrics = new MetricsCollector({
  enabled: process.env.NODE_ENV !== 'test',
});
