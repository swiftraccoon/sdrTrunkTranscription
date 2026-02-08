const express = require('express');
const router = express.Router();
const Subscription = require('../models/Subscription');
const { isAuthenticated } = require('./middleware/authMiddleware');
const logger = require('../utils/logger');

// Get subscription management page
router.get('/subscriptions', isAuthenticated, async (req, res) => {
  try {
    const subscriptions = await Subscription.find({ userId: req.session.userId });
    res.render('subscriptions', { subscriptions });
  } catch (error) {
    logger.error('Error fetching subscriptions:', error);
    req.flash('error', 'Failed to load subscriptions');
    res.redirect('/');
  }
});

// Create new subscription
router.post('/subscriptions', isAuthenticated, async (req, res) => {
  try {
    const { pattern, isRegex, emailNotification, email, keepHistory } = req.body;
    
    // Validate regex if isRegex is true
    if (isRegex === 'true') {
      try {
        new RegExp(pattern);
      } catch (e) {
        req.flash('error', 'Invalid regex pattern');
        return res.redirect('/subscriptions');
      }
    }

    const subscription = new Subscription({
      userId: req.session.userId,
      pattern,
      isRegex: isRegex === 'true',
      emailNotification: emailNotification === 'true',
      email: email || undefined,
      keepHistory: keepHistory === 'true'
    });

    await subscription.save();
    req.flash('success', 'Subscription created successfully');
    res.redirect('/subscriptions');
  } catch (error) {
    logger.error('Error creating subscription:', error);
    req.flash('error', 'Failed to create subscription');
    res.redirect('/subscriptions');
  }
});

// Delete subscription
router.delete('/subscriptions/:id', isAuthenticated, async (req, res) => {
  try {
    const result = await Subscription.deleteOne({
      _id: req.params.id,
      userId: req.session.userId
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    res.json({ message: 'Subscription deleted successfully' });
  } catch (error) {
    logger.error('Error deleting subscription:', error);
    res.status(500).json({ error: 'Failed to delete subscription' });
  }
});

// Get subscription matches
router.get('/subscriptions/:id/matches', isAuthenticated, async (req, res) => {
  try {
    const subscription = await Subscription.findOne({
      _id: req.params.id,
      userId: req.session.userId
    });

    if (!subscription) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    res.json({ matches: subscription.matches });
  } catch (error) {
    logger.error('Error fetching subscription matches:', error);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

module.exports = router; 