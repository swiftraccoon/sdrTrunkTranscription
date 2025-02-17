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

if (!process.env.DATABASE_URL || !process.env.SESSION_SECRET) {
  logger.error('Configuration error: required environment variables not set', {
    missing: [
      !process.env.DATABASE_URL && 'DATABASE_URL',
      !process.env.SESSION_SECRET && 'SESSION_SECRET',
    ].filter(Boolean),
  });
  process.exit(-1);
}

const app = express();
const port = process.env.PORT || 3000;
const httpsEnable = process.env.HTTPS_ENABLE === 'true';

// Middleware setup
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Database connection
mongoose
  .connect(process.env.DATABASE_URL)
  .then(() => {
    logger.info('Database connection established successfully');
  })
  .catch((err) => {
    logger.error('Database connection failed', {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  });

// Initialize talkgroup config after DB connection
(async () => {
  await talkgroupConfig.init();
})();

// Session configuration
const sessionParser = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    secure: httpsEnable,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
  store: MongoStore.create({
    mongoUrl: process.env.DATABASE_URL,
    ttl: 24 * 60 * 60,
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
if (process.env.VERBOSE_LOGGING === 'true') {
  app.use((req, res, next) => {
    logger.debug('Incoming request', {
      method: req.method,
      path: req.path,
      ip: req.ip,
    });
    next();
  });
}

// Error event handler
app.on('error', (error) => {
  logger.error('Server error event', {
    error: error.message,
    stack: error.stack,
  });
});

// Routes
app.use('/', authRoutes);
app.use('/', apiRoutes);
app.use('/', indexRoutes);
app.use('/', searchRoutes);
app.use('/', aiRoutes);
app.use('/', adminRoutes);
app.use('/', subscriptionRoutes);

// AI page route
app.get('/ai', isAuthenticated, tierAccessControl, (req, res) => {
  res.render('ai');
});

// 404 handler
app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Not Found',
    message: 'The page you are looking for does not exist.',
    action: '<a href="/" class="btn btn-primary">Return to Home</a>',
  });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled application error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });
  
  res.status(500).render('error', {
    title: 'Server Error',
    message: 'An unexpected error occurred',
    error: process.env.NODE_ENV === 'development' ? err : {},
    action: '<a href="/" class="btn btn-primary">Return to Home</a>'
  });
});

// Server setup
const setupServer = () => {
  if (httpsEnable) {
    try {
      const httpsOptions = {
        key: fs.readFileSync(process.env.SSL_KEY_PATH, 'utf8'),
        cert: fs.readFileSync(process.env.SSL_CERT_PATH, 'utf8'),
      };
      const httpsServer = https.createServer(httpsOptions, app);
      webSocketService.setupWebSocket(httpsServer, sessionParser);
      
      const host = process.env.WEBSITE_URL.replace(/https?:\/\//, '');
      httpsServer.listen(port, '0.0.0.0', () => {
        logger.info('HTTPS server started', { host, port });
      });
    } catch (error) {
      logger.error('HTTPS server startup failed', {
        error: error.message,
        stack: error.stack,
      });
    }
  } else {
    const server = http.createServer(app);
    webSocketService.setupWebSocket(server, sessionParser);
    
    const host = process.env.WEBSITE_URL.replace(/https?:\/\//, '');
    server.listen(port, '0.0.0.0', () => {
      logger.info('HTTP server started', { host, port });
    });
  }
};

setupServer();

module.exports = { sessionParser };
