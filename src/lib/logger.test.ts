/**
 * Structured Logger Tests
 * 
 * Comprehensive test coverage for structured logging including:
 * - Log level filtering
 * - Context propagation
 * - PII redaction
 * - Error formatting
 * - Pretty printing
 * 
 * @module lib/logger.test
 */

import { Logger, LogLevel, LogEntry } from './logger';

describe('Logger', () => {
  let logger: Logger;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    logger = new Logger({ level: LogLevel.TRACE, pretty: false });
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    logger.clearContext();
  });

  describe('Log Levels', () => {
    it('should log emergency messages', () => {
      logger.emergency('System failure');
      
      expect(consoleErrorSpy).toHaveBeenCalled();
      const output = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(output.level).toBe('EMERGENCY');
      expect(output.message).toBe('System failure');
    });

    it('should log alert messages', () => {
      logger.alert('Immediate action required');
      
      expect(consoleErrorSpy).toHaveBeenCalled();
      const output = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(output.level).toBe('ALERT');
    });

    it('should log critical messages', () => {
      logger.critical('Critical condition');
      
      expect(consoleErrorSpy).toHaveBeenCalled();
      const output = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(output.level).toBe('CRITICAL');
    });

    it('should log error messages', () => {
      logger.error('Error occurred');
      
      expect(consoleErrorSpy).toHaveBeenCalled();
      const output = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(output.level).toBe('ERROR');
    });

    it('should log warning messages', () => {
      logger.warn('Warning condition');
      
      expect(consoleWarnSpy).toHaveBeenCalled();
      const output = JSON.parse(consoleWarnSpy.mock.calls[0][0]);
      expect(output.level).toBe('WARN');
    });

    it('should log info messages', () => {
      logger.info('Information');
      
      expect(consoleLogSpy).toHaveBeenCalled();
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.level).toBe('INFO');
    });

    it('should log debug messages', () => {
      logger.debug('Debug info');
      
      expect(consoleLogSpy).toHaveBeenCalled();
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.level).toBe('DEBUG');
    });

    it('should log trace messages', () => {
      logger.trace('Trace info');
      
      expect(consoleLogSpy).toHaveBeenCalled();
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.level).toBe('TRACE');
    });
  });

  describe('Log Level Filtering', () => {
    it('should filter logs below configured level', () => {
      const infoLogger = new Logger({ level: LogLevel.INFO, pretty: false });
      
      infoLogger.debug('Should not appear');
      infoLogger.trace('Should not appear');
      infoLogger.info('Should appear');
      
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    });

    it('should allow all logs at TRACE level', () => {
      logger.emergency('1');
      logger.alert('2');
      logger.critical('3');
      logger.error('4');
      logger.warn('5');
      logger.info('6');
      logger.debug('7');
      logger.trace('8');
      
      const totalCalls = consoleLogSpy.mock.calls.length + 
                        consoleErrorSpy.mock.calls.length + 
                        consoleWarnSpy.mock.calls.length;
      expect(totalCalls).toBe(8);
    });

    it('should block all logs below ERROR level', () => {
      const errorLogger = new Logger({ level: LogLevel.ERROR, pretty: false });
      
      errorLogger.warn('Should not appear');
      errorLogger.info('Should not appear');
      errorLogger.debug('Should not appear');
      errorLogger.error('Should appear');
      
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('Structured Output', () => {
    it('should output valid JSON', () => {
      logger.info('Test message');
      
      const output = consoleLogSpy.mock.calls[0][0];
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it('should include timestamp in ISO 8601 format', () => {
      logger.info('Test');
      
      const output: LogEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.timestamp).toBeDefined();
      expect(() => new Date(output.timestamp)).not.toThrow();
      expect(new Date(output.timestamp).toISOString()).toBe(output.timestamp);
    });

    it('should include level and message', () => {
      logger.info('Test message');
      
      const output: LogEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.level).toBe('INFO');
      expect(output.message).toBe('Test message');
    });

    it('should include context data', () => {
      logger.info('Test', { userId: '123', action: 'login' });
      
      const output: LogEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.context).toEqual({ userId: '123', action: 'login' });
    });

    it('should extract requestId from context', () => {
      logger.info('Test', { requestId: 'req-123', other: 'data' });
      
      const output: LogEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.requestId).toBe('req-123');
      expect(output.context).toEqual({ other: 'data' });
    });

    it('should extract userId from context', () => {
      logger.info('Test', { userId: 'user-456', other: 'data' });
      
      const output: LogEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.userId).toBe('user-456');
      expect(output.context).toEqual({ other: 'data' });
    });
  });

  describe('Context Propagation', () => {
    it('should set persistent context', () => {
      logger.setContext({ service: 'api', version: '1.0' });
      logger.info('Message 1');
      logger.info('Message 2');
      
      const output1: LogEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      const output2: LogEntry = JSON.parse(consoleLogSpy.mock.calls[1][0]);
      
      expect(output1['service']).toBe('api');
      expect(output1['version']).toBe('1.0');
      expect(output2['service']).toBe('api');
      expect(output2['version']).toBe('1.0');
    });

    it('should merge context with log-specific data', () => {
      logger.setContext({ service: 'api' });
      logger.info('Test', { requestId: 'req-123' });
      
      const output: LogEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output['service']).toBe('api');
      expect(output.requestId).toBe('req-123');
    });

    it('should clear context', () => {
      logger.setContext({ service: 'api' });
      logger.clearContext();
      logger.info('Test');
      
      const output: LogEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output['service']).toBeUndefined();
    });

    it('should create child logger with additional context', () => {
      logger.setContext({ service: 'api' });
      const childLogger = logger.child({ module: 'auth' });
      
      childLogger.info('Child log');
      
      const output: LogEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output['service']).toBe('api');
      expect(output['module']).toBe('auth');
    });

    it('should not affect parent logger from child', () => {
      const childLogger = logger.child({ child: 'data' });
      
      logger.info('Parent log');
      childLogger.info('Child log');
      
      const parentOutput: LogEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      const childOutput: LogEntry = JSON.parse(consoleLogSpy.mock.calls[1][0]);
      
      expect(parentOutput['child']).toBeUndefined();
      expect(childOutput['child']).toBe('data');
    });
  });

  describe('PII Redaction', () => {
    it('should redact password fields', () => {
      logger.info('User login', { username: 'john', password: 'secret123' });
      
      const output: LogEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.context?.password).toBe('[REDACTED]');
      expect(output.context?.username).toBe('john');
    });

    it('should redact token fields', () => {
      logger.info('API call', { token: 'abc123', apiKey: 'xyz789' });
      
      const output: LogEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.context?.token).toBe('[REDACTED]');
      expect(output.context?.apiKey).toBe('[REDACTED]');
    });

    it('should redact authorization headers', () => {
      logger.info('Request', { authorization: 'Bearer token123' });
      
      const output: LogEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.context?.authorization).toBe('[REDACTED]');
    });

    it('should redact nested sensitive fields', () => {
      logger.info('User data', {
        user: {
          name: 'John',
          password: 'secret',
          profile: {
            email: 'john@example.com',
            secret: 'hidden',
          },
        },
      });
      
      const output: LogEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      const user = output.context?.user as any;
      expect(user.name).toBe('John');
      expect(user.password).toBe('[REDACTED]');
      expect(user.profile.email).toBe('john@example.com');
      expect(user.profile.secret).toBe('[REDACTED]');
    });

    it('should redact fields case-insensitively', () => {
      logger.info('Test', { PASSWORD: 'secret', Token: 'abc', API_KEY: 'xyz' });
      
      const output: LogEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.context?.PASSWORD).toBe('[REDACTED]');
      expect(output.context?.Token).toBe('[REDACTED]');
      expect(output.context?.API_KEY).toBe('[REDACTED]');
    });

    it('should redact credit card fields', () => {
      logger.info('Payment', { creditCard: '4111111111111111', amount: 100 });
      
      const output: LogEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.context?.creditCard).toBe('[REDACTED]');
      expect(output.context?.amount).toBe(100);
    });

    it('should handle arrays with sensitive data', () => {
      logger.info('Batch', {
        users: [
          { name: 'John', password: 'secret1' },
          { name: 'Jane', password: 'secret2' },
        ],
      });
      
      const output: LogEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      const users = output.context?.users as any[];
      expect(users[0].password).toBe('[REDACTED]');
      expect(users[1].password).toBe('[REDACTED]');
      expect(users[0].name).toBe('John');
    });
  });

  describe('Error Formatting', () => {
    it('should format Error objects', () => {
      const error = new Error('Test error');
      logger.error('Error occurred', { error });
      
      const output: LogEntry = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(output.error).toBeDefined();
      expect(output.error?.name).toBe('Error');
      expect(output.error?.message).toBe('Test error');
    });

    it('should include stack trace when configured', () => {
      const errorLogger = new Logger({ level: LogLevel.ERROR, includeStackTrace: true, pretty: false });
      const error = new Error('Test error');
      
      errorLogger.error('Error occurred', { error });
      
      const output: LogEntry = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(output.error?.stack).toBeDefined();
      expect(output.error?.stack).toContain('Test error');
    });

    it('should exclude stack trace when configured', () => {
      const errorLogger = new Logger({ level: LogLevel.ERROR, includeStackTrace: false, pretty: false });
      const error = new Error('Test error');
      
      errorLogger.error('Error occurred', { error });
      
      const output: LogEntry = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(output.error?.stack).toBeUndefined();
    });

    it('should handle non-Error objects', () => {
      logger.error('Error occurred', { error: 'String error' });
      
      const output: LogEntry = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(output.error?.name).toBe('UnknownError');
      expect(output.error?.message).toBe('String error');
    });

    it('should handle custom error types', () => {
      class CustomError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'CustomError';
        }
      }
      
      const error = new CustomError('Custom error message');
      logger.error('Error occurred', { error });
      
      const output: LogEntry = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(output.error?.name).toBe('CustomError');
      expect(output.error?.message).toBe('Custom error message');
    });
  });

  describe('Pretty Printing', () => {
    it('should pretty print when enabled', () => {
      const prettyLogger = new Logger({ level: LogLevel.INFO, pretty: true });
      
      prettyLogger.info('Test message');
      
      const output = consoleLogSpy.mock.calls[0][0];
      expect(typeof output).toBe('string');
      expect(output).toContain('[INFO]');
      expect(output).toContain('Test message');
      expect(() => JSON.parse(output)).toThrow(); // Not JSON
    });

    it('should include requestId in pretty format', () => {
      const prettyLogger = new Logger({ level: LogLevel.INFO, pretty: true });
      
      prettyLogger.info('Test', { requestId: 'req-123' });
      
      const output = consoleLogSpy.mock.calls[0][0];
      expect(output).toContain('(req: req-123)');
    });

    it('should include userId in pretty format', () => {
      const prettyLogger = new Logger({ level: LogLevel.INFO, pretty: true });
      
      prettyLogger.info('Test', { userId: 'user-456' });
      
      const output = consoleLogSpy.mock.calls[0][0];
      expect(output).toContain('(user: user-456)');
    });

    it('should include context in pretty format', () => {
      const prettyLogger = new Logger({ level: LogLevel.INFO, pretty: true });
      
      prettyLogger.info('Test', { key: 'value' });
      
      const output = consoleLogSpy.mock.calls[0][0];
      expect(output).toContain('"key":"value"');
    });

    it('should format errors in pretty mode', () => {
      const prettyLogger = new Logger({ level: LogLevel.ERROR, pretty: true, includeStackTrace: true });
      const error = new Error('Test error');
      
      prettyLogger.error('Error occurred', { error });
      
      const output = consoleErrorSpy.mock.calls[0][0];
      expect(output).toContain('Error: Error: Test error');
    });
  });

  describe('Configuration', () => {
    it('should use default log level from environment', () => {
      process.env.LOG_LEVEL = 'WARN';
      const envLogger = new Logger({ pretty: false });
      
      envLogger.info('Should not appear');
      envLogger.warn('Should appear');
      
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalled();
      
      delete process.env.LOG_LEVEL;
    });

    it('should default to INFO in production', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      
      const prodLogger = new Logger({ pretty: false });
      
      // Access private config to verify
      expect(prodLogger['config'].level).toBe(LogLevel.INFO);
      
      process.env.NODE_ENV = originalEnv;
    });

    it('should default to DEBUG in development', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      
      const devLogger = new Logger({ pretty: false });
      
      expect(devLogger['config'].level).toBe(LogLevel.DEBUG);
      
      process.env.NODE_ENV = originalEnv;
    });

    it('should use pretty printing in non-production', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      
      const devLogger = new Logger();
      
      expect(devLogger['config'].pretty).toBe(true);
      
      process.env.NODE_ENV = originalEnv;
    });

    it('should disable pretty printing in production', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      
      const prodLogger = new Logger();
      
      expect(prodLogger['config'].pretty).toBe(false);
      
      process.env.NODE_ENV = originalEnv;
    });
  });

  describe('Edge Cases', () => {
    it('should handle null context', () => {
      logger.info('Test', null as any);
      
      expect(consoleLogSpy).toHaveBeenCalled();
      const output: LogEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.context).toBeUndefined();
    });

    it('should handle undefined context', () => {
      logger.info('Test', undefined);
      
      expect(consoleLogSpy).toHaveBeenCalled();
      const output: LogEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.context).toBeUndefined();
    });

    it('should handle circular references in context', () => {
      const circular: any = { name: 'test' };
      circular.self = circular;
      
      // Should not throw
      expect(() => logger.info('Test', circular)).not.toThrow();
    });

    it('should handle very long messages', () => {
      const longMessage = 'A'.repeat(10000);
      
      expect(() => logger.info(longMessage)).not.toThrow();
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it('should handle special characters in messages', () => {
      logger.info('Test with "quotes" and \n newlines \t tabs');
      
      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0][0];
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it('should handle empty context object', () => {
      logger.info('Test', {});
      
      const output: LogEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.context).toBeUndefined();
    });
  });

  describe('Performance', () => {
    it('should handle high-frequency logging', () => {
      const iterations = 1000;
      const start = Date.now();
      
      for (let i = 0; i < iterations; i++) {
        logger.info(`Message ${i}`);
      }
      
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(1000); // Should complete in < 1 second
      expect(consoleLogSpy).toHaveBeenCalledTimes(iterations);
    });

    it('should not log when below threshold', () => {
      const warnLogger = new Logger({ level: LogLevel.WARN, pretty: false });
      const iterations = 1000;
      
      for (let i = 0; i < iterations; i++) {
        warnLogger.debug(`Message ${i}`);
      }
      
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });
});
