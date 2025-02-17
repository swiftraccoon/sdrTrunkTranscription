const { createLogger, format, transports } = require('winston');
const path = require('path');

// Create a logger instance
const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss',
    }),
    format.errors({ stack: true }),
    format.splat(),
    format.json(),
  ),
  defaultMeta: { service: 'websocket-service' },
  transports: [
    new transports.File({ filename: path.join(__dirname, '../logs/websocket-error.log'), level: 'error' }),
    new transports.File({ filename: path.join(__dirname, '../logs/websocket-combined.log') }),
  ],
});

// If we're not in production then log to the `console` with the format:
// `${info.level}: ${info.message} JSON.stringify({ ...rest }) `
if (process.env.NODE_ENV !== 'production') {
  logger.add(new transports.Console({
    format: format.combine(
      format.colorize(),
      format.simple(),
    ),
  }));
}

module.exports = logger;
