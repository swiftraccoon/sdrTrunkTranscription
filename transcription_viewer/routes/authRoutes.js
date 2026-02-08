const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const logger = require('../utils/logger');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/register', (req, res) => {
  res.render('register');
});

router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || typeof username !== 'string' || !/^[a-zA-Z0-9]{3,30}$/.test(username)) {
      return res.status(400).send('Username must be 3-30 alphanumeric characters');
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).send('Password must be at least 8 characters');
    }

    // User model will automatically hash the password using bcrypt
    await User.create({ username, password, tier: 'registered' });
    res.redirect('/login');
  } catch (error) {
    logger.error('Registration error:', error);
    res.status(500).send('Registration failed');
  }
});

router.get('/login', (req, res) => {
  res.render('login');
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || typeof username !== 'string' || !/^[a-zA-Z0-9]{3,30}$/.test(username)) {
      return res.status(400).send('Invalid username or password');
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).send('Invalid username or password');
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(400).send('Invalid username or password');
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).send('Invalid username or password');
    }

    // Regenerate session to prevent session fixation
    const userId = user._id;
    const userTier = user.tier;
    req.session.regenerate((err) => {
      if (err) {
        logger.error('Session regeneration error:', err);
        return res.status(500).send('Login failed');
      }
      req.session.userId = userId;
      req.session.userTier = userTier;
      return res.redirect('/');
    });
  } catch (error) {
    logger.error('Login error:', error);
    return res.status(500).send('Login failed');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      logger.error('Error during session destruction:', err);
      return res.status(500).send('Error logging out');
    }
    res.redirect('/login');
  });
});

module.exports = router;
