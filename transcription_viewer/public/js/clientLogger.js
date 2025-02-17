/* global console */

/**
 * Client-side logging utility that provides consistent logging across the frontend.
 * Logs are prefixed with timestamps and can be filtered by level.
 */
class ClientLogger {
  constructor(options = {}) {
    this.debugMode = options.debugMode || process.env.NODE_ENV !== 'production';
    this.prefix = options.prefix || '';
    this.levels = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
    };
    this.minLevel = this.levels[options.minLevel || 'debug'];
  }

  formatMessage(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const prefix = this.prefix ? `[${this.prefix}] ` : '';
    return {
      timestamp,
      level,
      message: `${prefix}${message}`,
      data,
    };
  }

  shouldLog(level) {
    return this.levels[level] >= this.minLevel;
  }

  debug(message, data) {
    if (!this.shouldLog('debug')) return;
    const logData = this.formatMessage('debug', message, data);
    if (Object.keys(data || {}).length > 0) {
      console.debug(logData.message, data);
    } else {
      console.debug(logData.message);
    }
  }

  info(message, data) {
    if (!this.shouldLog('info')) return;
    const logData = this.formatMessage('info', message, data);
    if (Object.keys(data || {}).length > 0) {
      console.info(logData.message, data);
    } else {
      console.info(logData.message);
    }
  }

  warn(message, data) {
    if (!this.shouldLog('warn')) return;
    const logData = this.formatMessage('warn', message, data);
    if (Object.keys(data || {}).length > 0) {
      console.warn(logData.message, data);
    } else {
      console.warn(logData.message);
    }
  }

  error(message, error, data = {}) {
    if (!this.shouldLog('error')) return;
    const logData = this.formatMessage('error', message, {
      ...data,
      error: error?.message || error,
      stack: error?.stack,
    });
    if (error?.stack) {
      console.error(logData.message, error);
    } else if (Object.keys(data).length > 0) {
      console.error(logData.message, { error, ...data });
    } else {
      console.error(logData.message);
    }
  }
}

// Create and export a default logger instance
const logger = new ClientLogger({
  prefix: 'App',
  minLevel: 'debug',
  debugMode: true
});

export default logger; 