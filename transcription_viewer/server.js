// Load environment variables
require('dotenv').config();
const mongoose = require('mongoose');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const flash = require('express-flash');
const fs = require('fs');
const https = require('https');
const http = require('http');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const authRoutes = require('./routes/authRoutes');
const apiRoutes = require('./routes/apiRoutes');
const indexRoutes = require('./routes/indexRoutes');
const searchRoutes = require('./routes/searchRoutes');
const aiRoutes = require('./routes/aiRoutes');
const adminRoutes = require('./routes/adminRoutes');
const subscriptionRoutes = require('./routes/subscriptionRoutes');
const { isAuthenticated, tierAccessControl } = require('./routes/middleware/authMiddleware');
const webSocketService = require('./webSocketService');
const talkgroupConfig = require('./utils/talkgroupConfig');
const logger = require('./utils/logger');

/**
 * Environment variable validation
 * Validates all required environment variables are set before starting the server
 */
const requiredEnvVars = {
  DATABASE_URL: process.env.DATABASE_URL,
  SESSION_SECRET: process.env.SESSION_SECRET,
};

// Add SSL-related env vars to required list if HTTPS is enabled
if (process.env.HTTPS_ENABLE === 'true') {
  requiredEnvVars.SSL_KEY_PATH = process.env.SSL_KEY_PATH;
  requiredEnvVars.SSL_CERT_PATH = process.env.SSL_CERT_PATH;
  requiredEnvVars.WEBSITE_URL = process.env.WEBSITE_URL;
}

const missingEnvVars = Object.entries(requiredEnvVars)
  .filter(([_, value]) => !value)
  .map(([key]) => key);

if (missingEnvVars.length > 0) {
  logger.error('Configuration error: required environment variables not set', {
    missing: missingEnvVars,
  });
  process.exit(1);
}

// Configuration constants
const CONFIG = {
  PORT: process.env.PORT || 3000,
  HTTPS_ENABLED: process.env.HTTPS_ENABLE === 'true',
  NODE_ENV: process.env.NODE_ENV || 'development',
  COOKIE_MAX_AGE: parseInt(process.env.COOKIE_MAX_AGE || 24 * 60 * 60 * 1000), // Default: 24 hours
  SESSION_TTL: parseInt(process.env.SESSION_TTL || 24 * 60 * 60), // Default: 24 hours
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000), // Default: 15 minutes
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX || 1000), // Default: 100 requests per window
  VERBOSE_LOGGING: process.env.VERBOSE_LOGGING === 'true',
};

const app = express();

/**
 * Graceful shutdown function
 * Closes server and database connections properly
 */
const gracefulShutdown = (server, reason) => {
  logger.info(`Initiating graceful shutdown: ${reason}`);
  
  server.close(() => {
    logger.info('HTTP server closed');
    
    mongoose.connection.close(false)
      .then(() => {
        logger.info('Database connection closed');
        process.exit(0);
      })
      .catch((err) => {
        logger.error('Error during database disconnection', {
          error: err.message,
          stack: err.stack,
        });
        process.exit(1);
      });
  });
  
  // Force close if graceful shutdown fails
  setTimeout(() => {
    logger.error('Forced shutdown: could not close connections in time');
    process.exit(1);
  }, 30000);
};

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "unpkg.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "fonts.googleapis.com", "unpkg.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      fontSrc: ["'self'", "fonts.gstatic.com", "data:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  // Other security headers remain with default settings
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: CONFIG.RATE_LIMIT_WINDOW_MS,
  max: CONFIG.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again later',
});
app.use(limiter);

// Performance middleware
app.use(compression());

// Body parsers
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// View engine setup
app.set('view engine', 'ejs');

// Static file serving with cache headers
const staticOptions = {
  maxAge: CONFIG.NODE_ENV === 'production' ? '1d' : 0,
  etag: true,
};
app.use(express.static('public', staticOptions));
app.use('/uploads', express.static('uploads', staticOptions));

/**
 * Database connection
 * Connects to MongoDB with optimized settings
 */
mongoose
  .connect(process.env.DATABASE_URL, {
    // Connection pool size optimization
    maxPoolSize: 10,
    minPoolSize: 2,
    // Connection timeout settings
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  })
  .then(() => {
    logger.info('Database connection established successfully');
    
    // Initialize talkgroup config after DB connection
    try {
      talkgroupConfig.init()
        .then(() => {
          logger.info('Talkgroup configuration initialized successfully');
        })
        .catch((err) => {
          logger.error('Failed to initialize talkgroup configuration', {
            error: err.message,
            stack: err.stack,
          });
        });
    } catch (err) {
      logger.error('Error during talkgroup initialization', {
        error: err.message,
        stack: err.stack,
      });
    }
  })
  .catch((err) => {
    logger.error('Database connection failed', {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  });

/**
 * Session configuration
 * Sets up secure session handling with MongoDB store
 */
const sessionParser = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    secure: CONFIG.HTTPS_ENABLED,
    httpOnly: true,
    maxAge: CONFIG.COOKIE_MAX_AGE,
    sameSite: 'lax', // Prevents CSRF attacks
  },
  store: MongoStore.create({
    mongoUrl: process.env.DATABASE_URL,
    ttl: CONFIG.SESSION_TTL,
    touchAfter: 24 * 3600, // Only update session if data changed
  }),
});

app.use(sessionParser);
app.use(flash());

// Make session and flash data available to views
app.use((req, res, next) => {
  res.locals.session = req.session || {};
  res.locals.messages = {
    success: req.flash('success'),
    error: req.flash('error'),
    info: req.flash('info'),
  };
  next();
});

// Request logging in verbose mode
if (CONFIG.VERBOSE_LOGGING) {
  app.use((req, res, next) => {
    logger.debug('Incoming request', {
      method: req.method,
      path: req.path,
      ip: req.ip,
    });
    next();
  });
}

// Health check endpoint
app.get('/health', (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  
  res.status(dbStatus === 'connected' ? 200 : 503).json({
    status: dbStatus === 'connected' ? 'ok' : 'error',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    dbStatus,
  });
});

// Error event handler
app.on('error', (error) => {
  logger.error('Server error event', {
    error: error.message,
    stack: error.stack,
  });
});

app.use('/auth', authRoutes);
app.use('/api', apiRoutes);
app.use('/', indexRoutes);
app.use('/', searchRoutes);
app.use('/', aiRoutes);
app.use('/', adminRoutes);
app.use('/', subscriptionRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Not Found',
    message: 'The page you are looking for does not exist.',
    action: '<a href="/" class="btn btn-primary">Return to Home</a>',
  });
});

/**
 * Global error handler
 * Handles all uncaught errors in the application
 */
app.use((err, req, res, next) => {
  logger.error('Unhandled application error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });
  
  // Check if headers have already been sent
  if (res.headersSent) {
    return next(err);
  }
  
  res.status(500).render('error', {
    title: 'Server Error',
    message: 'An unexpected error occurred',
    error: CONFIG.NODE_ENV === 'development' ? err : {},
    action: '<a href="/" class="btn btn-primary">Return to Home</a>'
  });
});

/**
 * Server setup function
 * Sets up HTTP or HTTPS server based on configuration
 * @returns {Object} The created server instance
 */
const setupServer = () => {
  let server;
  
  if (CONFIG.HTTPS_ENABLED) {
    try {
      // Verify SSL files exist before attempting to read them
      if (!fs.existsSync(process.env.SSL_KEY_PATH) || !fs.existsSync(process.env.SSL_CERT_PATH)) {
        throw new Error('SSL certificate files not found');
      }
      
      const httpsOptions = {
        key: fs.readFileSync(process.env.SSL_KEY_PATH, 'utf8'),
        cert: fs.readFileSync(process.env.SSL_CERT_PATH, 'utf8'),
      };
      
      server = https.createServer(httpsOptions, app);
      webSocketService.setupWebSocket(server, sessionParser);
      
      const host = process.env.WEBSITE_URL.replace(/https?:\/\//, '');
      server.listen(CONFIG.PORT, '0.0.0.0', () => {
        logger.info('HTTPS server started', { host, port: CONFIG.PORT });
      });
    } catch (error) {
      logger.error('HTTPS server startup failed', {
        error: error.message,
        stack: error.stack,
      });
      
      // Fallback to HTTP if HTTPS fails
      logger.info('Falling back to HTTP server');
      server = setupHttpServer();
    }
  } else {
    server = setupHttpServer();
  }
  
  return server;
};

/**
 * HTTP server setup helper function
 * @returns {Object} The created HTTP server instance
 */
const setupHttpServer = () => {
  const server = http.createServer(app);
  webSocketService.setupWebSocket(server, sessionParser);
  
  const host = process.env.WEBSITE_URL ? process.env.WEBSITE_URL.replace(/https?:\/\//, '') : 'localhost';
  server.listen(CONFIG.PORT, '0.0.0.0', () => {
    logger.info('HTTP server started', { host, port: CONFIG.PORT });
  });
  
  return server;
};

// Start the server
const server = setupServer();

// Set up graceful shutdown handlers
process.on('SIGTERM', () => gracefulShutdown(server, 'SIGTERM signal received'));
process.on('SIGINT', () => gracefulShutdown(server, 'SIGINT signal received'));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', {
    error: err.message,
    stack: err.stack,
  });
  gracefulShutdown(server, 'Uncaught exception');
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', {
    reason: reason instanceof Error ? reason.message : reason,
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

module.exports = { app, server, sessionParser };
