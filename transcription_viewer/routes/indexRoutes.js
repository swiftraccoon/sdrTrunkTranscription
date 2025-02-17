// routes/indexRoutes.js
const express = require('express');

const router = express.Router();
const Transcription = require('../models/Transcription');
const { isAuthenticated, tierAccessControl } = require('./middleware/authMiddleware');
const talkgroupConfig = require('../utils/talkgroupConfig');
const cacheService = require('../cacheService');

// Redirect /login to /auth/login
router.get('/login', (req, res) => {
  res.redirect('/auth/login');
});

router.get('/', isAuthenticated, tierAccessControl, async (req, res) => {
  try {
    // All users get the same limit now
    const limit = 30;

    const selectedGroup = req.query.group;
    const groups = talkgroupConfig.getAllGroups();
    // Send the raw group mappings from env instead of processed ones
    const groupMappings = {};
    const groupKeys = (process.env.GROUP_KEYS || '').split(',');
    groupKeys.forEach(key => {
      if (process.env[key.trim()]) {
        groupMappings[key.trim()] = process.env[key.trim()];
      }
    });

    // Simple caching for initial load
    const transcriptionsCacheKey = `recent_transcriptions_${limit}_${selectedGroup || 'All'}`;
    let transcriptions = cacheService.getFromCache(transcriptionsCacheKey);

    if (!transcriptions) {
      const query = {};
      if (selectedGroup && selectedGroup !== 'All') {
        try {
          const groupIds = talkgroupConfig.getGroupIds(selectedGroup);
          query.talkgroupId = { $in: groupIds };
        } catch (error) {
          console.error('Error fetching group IDs:', error);
          return res.status(400).send('Error loading homepage with group filter');
        }
      }

      transcriptions = await Transcription.find(query)
        .sort({ timestamp: -1 })
        .limit(limit);

      // Filter & enrich
      transcriptions = Transcription.filterTranscriptions(transcriptions).map((t) => {
        const groupName = talkgroupConfig.getGroupName(t.talkgroupId);
        const talkgroupName = talkgroupConfig.getTalkgroupName(t.talkgroupId);
        return {
          ...t._doc,
          groupName: groupName || 'Unknown Group',
          talkgroupName: talkgroupName
            ? `${t.talkgroupId} (${talkgroupName})`
            : `TGID ${t.talkgroupId}`,
        };
      });

      cacheService.saveToCache(transcriptionsCacheKey, transcriptions);
      console.log(`Fetched & cached for tier='${userTier}', group='${selectedGroup || 'All'}'`);
    } else {
      console.log(`Fetched from cache for tier='${userTier}', group='${selectedGroup || 'All'}'`);
    }

    // Render index
    res.render('index', {
      transcriptions,
      groups,
      selectedGroup,
      groupMappings,
      userTier, // needed in EJS
    });
  } catch (error) {
    console.error('Error fetching transcriptions with group filter:', error);
    res.status(500).send('Error loading homepage with group filter');
  }
});

/**
 * GET /api/transcriptions
 * Timestamp-based pagination for all users
 * ?before=<timestamp>&group=<groupName>
 */
router.get('/api/transcriptions', isAuthenticated, tierAccessControl, async (req, res) => {
  try {
    const limit = 120;
    const beforeTimestamp = req.query.before;
    const groupParam = req.query.group || 'All';

    if (!beforeTimestamp) {
      return res.status(400).json({ error: 'Missing "before" parameter' });
    }

    // Build the query
    const query = { timestamp: { $lt: new Date(beforeTimestamp) } };
    if (groupParam !== 'All') {
      const groupIds = talkgroupConfig.getGroupIds(groupParam);
      query.talkgroupId = { $in: groupIds };
    }

    let transcriptions = await Transcription.find(query)
      .sort({ timestamp: -1 })
      .limit(limit);

    // Filter & enrich
    transcriptions = Transcription.filterTranscriptions(transcriptions).map((t) => {
      const groupName = talkgroupConfig.getGroupName(t.talkgroupId);
      const talkgroupName = talkgroupConfig.getTalkgroupName(t.talkgroupId);
      return {
        ...t._doc,
        groupName: groupName || 'Unknown Group',
        talkgroupName: talkgroupName
          ? `${t.talkgroupId} (${talkgroupName})`
          : `TGID ${t.talkgroupId}`,
      };
    });

    res.json(transcriptions);
  } catch (err) {
    console.error('Error in /api/transcriptions:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;
