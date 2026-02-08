// Suppress console output during tests
const noop = () => {};
global.console = {
  ...console,
  log: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';
process.env.API_KEY = 'test-api-key';
process.env.DATABASE_URL = 'mongodb://localhost:27017/test';
