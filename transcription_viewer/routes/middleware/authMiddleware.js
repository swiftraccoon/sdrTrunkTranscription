const User = require('../../models/User');
const logger = require('../../utils/logger');

const isAuthenticated = (req, res, next) => {
  if (!req.session.userId) {
    logger.info('Authentication check failed - redirecting to login', {
      path: req.path,
      method: req.method,
    });
    return res.redirect('/login');
  }
  return next();
};

const tierAccessControl = async (req, res, next) => {
  try {
    if (!req.session || !req.session.userId) {
      logger.info('Tier access check failed - no session or userId', {
        path: req.path,
        method: req.method,
      });
      return res.redirect('/auth/login');
    }

    const user = await User.findById(req.session.userId);
    if (!user) {
      logger.warn('Tier access check failed - user not found in database', {
        userId: req.session.userId,
        path: req.path,
      });
      return res.redirect('/auth/login');
    }

    // Make user's tier available in res.locals
    res.locals.userTier = user.tier;
    res.locals.user = user;

    return next();
  } catch (error) {
    logger.error('Error during tier access control', {
      error: error.message,
      stack: error.stack,
      userId: req.session.userId,
      path: req.path,
    });
    return res.status(500).send('Internal Server Error');
  }
};

const isAdmin = async (req, res, next) => {
  if (!req.session.userId) {
    logger.info('Admin access check failed - no session', {
      path: req.path,
      method: req.method,
    });
    return res.redirect('/login');
  }

  try {
    const user = await User.findById(req.session.userId);
    if (!user || user.tier !== 'admin') {
      logger.warn('Admin access check failed - insufficient privileges', {
        userId: req.session.userId,
        userTier: user?.tier,
        path: req.path,
      });
      return res.status(403).render('error', {
        message: 'Access denied. Admin privileges required.',
      });
    }
    return next();
  } catch (error) {
    logger.error('Error during admin authentication', {
      error: error.message,
      stack: error.stack,
      userId: req.session.userId,
      path: req.path,
    });
    return res.status(500).render('error', {
      message: 'Internal server error during authentication',
    });
  }
};

module.exports = {
  isAuthenticated,
  tierAccessControl,
  isAdmin,
};
