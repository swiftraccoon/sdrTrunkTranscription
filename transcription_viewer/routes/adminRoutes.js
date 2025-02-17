// routes/adminRoutes.js
const express = require('express');

const router = express.Router();
const rateLimit = require('express-rate-limit');
const flash = require('express-flash');
const User = require('../models/User');
const LLMInteraction = require('../models/LLMInteraction');
const { isAuthenticated, isAdmin } = require('./middleware/authMiddleware');

// Rate limiting for admin routes - more restrictive for security
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // limit each IP to 50 requests per windowMs
  message: 'Too many requests from this IP for admin routes, please try again later.',
});

// Apply rate limiting to all admin routes
router.use('/admin', adminLimiter);

// Apply flash messages
router.use(flash());

// Apply authentication check to all admin routes
router.use('/admin', isAuthenticated);

// Apply admin check to all admin routes
router.use('/admin', isAdmin);

/**
 * GET /admin/users
 * Show all users, including username + tier.
 */
router.get('/admin/users', async (req, res) => {
  try {
    const users = await User.find({}, { username: 1, tier: 1, createdAt: 1 })
      .sort({ username: 1 });
    res.render('adminUsers', {
      users,
      activeTab: 'users',
      messages: {
        success: req.flash('success'),
        error: req.flash('error'),
      },
    });
  } catch (error) {
    console.error('Error fetching users for admin:', error);
    return res.status(500).render('error', {
      title: 'Server Error',
      message: 'Error loading admin users page',
      action: '<a href="/admin/users" class="btn btn-primary">Try Again</a>',
    });
  }
});

/**
 * GET /admin/llm-interactions
 * Show all LLM interactions
 */
router.get('/admin/llm-interactions', async (req, res) => {
  try {
    const interactions = await LLMInteraction.find()
      .populate('userId', 'username')
      .sort({ createdAt: -1 })
      .limit(100);
    res.render('adminLLMInteractions', {
      interactions,
      activeTab: 'llm',
      messages: {
        success: req.flash('success'),
        error: req.flash('error'),
      },
    });
  } catch (error) {
    console.error('Error fetching LLM interactions:', error);
    return res.status(500).render('error', {
      title: 'Server Error',
      message: 'Error loading LLM interactions page',
      action: '<a href="/admin/llm-interactions" class="btn btn-primary">Try Again</a>',
    });
  }
});

/**
 * POST /admin/users/:userId/tier
 * Endpoint to update a user's tier
 */
router.post('/admin/users/:userId/tier', async (req, res) => {
  const { userId } = req.params;
  const { newTier } = req.body;

  // Validate new tier
  const allowedTiers = ['registered', 'admin'];
  if (!allowedTiers.includes(newTier)) {
    req.flash('error', 'Invalid tier specified');
    return res.redirect('/admin/users');
  }

  try {
    // Prevent changing own tier (additional security measure)
    if (userId === res.locals.user._id.toString()) {
      req.flash('error', 'Administrators cannot modify their own tier');
      return res.redirect('/admin/users');
    }

    // Check if target user exists
    const targetUser = await User.findById(userId);
    if (!targetUser) {
      req.flash('error', 'User not found');
      return res.redirect('/admin/users');
    }

    // Update the user's tier
    await User.findByIdAndUpdate(userId, { tier: newTier });

    // Set success message and redirect
    req.flash('success', `Successfully updated ${targetUser.username}'s tier to ${newTier}`);
    res.redirect('/admin/users');
  } catch (error) {
    console.error(`Error updating tier for user ${userId}:`, error);
    req.flash('error', 'Error updating user tier');
    res.redirect('/admin/users');
  }
});

module.exports = router;
