// routes/searchRoutes.js
const express = require('express');

const router = express.Router();
const moment = require('moment');
const Transcription = require('../models/Transcription');
const { isAuthenticated, tierAccessControl } = require('./middleware/authMiddleware');

// If you have a separate Talkgroup model or talkgroupConfig:
const talkgroupConfig = require('../utils/talkgroupConfig');
// or if you have a Talkgroup model, e.g. const Talkgroup = require('../models/Talkgroup');

// Adjusted search endpoint
router.get('/search', isAuthenticated, tierAccessControl, async (req, res) => {
  try {
    const {
      keyword, startDate, startTime, endDate, endTime, talkgroupId, radioId,
    } = req.query;

    const query = {};

    // Keyword in transcription text
    if (keyword) {
      query.text = { $regex: keyword, $options: 'i' };
    }

    // Start/end date and time logic
    if (startDate || endDate) {
      let startTimestamp, endTimestamp;
      if (startDate) {
        startTimestamp = new Date(`${startDate}T${startTime || '00:00'}`);
      }
      if (endDate) {
        endTimestamp = new Date(`${endDate}T${endTime || '23:59'}`);
      }
      if (startTimestamp && endTimestamp) {
        query.timestamp = { $gte: startTimestamp, $lte: endTimestamp };
      } else if (startTimestamp) {
        query.timestamp = { $gte: startTimestamp };
      } else if (endTimestamp) {
        query.timestamp = { $lte: endTimestamp };
      }
    }

    // Talkgroup + Radio ID
    if (talkgroupId) query.talkgroupId = talkgroupId;
    if (radioId) query.radioId = radioId;

    console.log('Executing search with query:', query);

    // Perform search
    const transcriptions = await Transcription.find(query).sort({ timestamp: -1 });
    console.log(`Search results found: ${transcriptions.length} transcriptions`);

    res.render('searchResults', {
      transcriptions,
      query: {
        keyword, startDate, startTime, endDate, endTime, talkgroupId, radioId,
      },
    });
  } catch (error) {
    console.error('Error during transcription search:', error);
    console.error(error.stack);
    res.status(500).send('Error searching transcriptions');
  }
});

// Show the search form
router.get('/search-form', isAuthenticated, tierAccessControl, (req, res) => {
  try {
    const {
      keyword, startDate, startTime, endDate, endTime, talkgroupId, radioId,
    } = req.query;

    // Default the start date to 48 hours ago, end date to 1 hour from now,
    // if the user didn't provide them
    const defaultStart = moment().subtract(48, 'hours').format('YYYY-MM-DD');
    const defaultEnd = moment().add(1, 'hours').format('YYYY-MM-DD');

    res.render('searchForm', {
      query: {
        keyword: keyword || '',
        startDate: startDate || defaultStart,
        startTime: startTime || '00:00',
        endDate: endDate || defaultEnd,
        endTime: endTime || '23:59',
        talkgroupId: talkgroupId || '',
        radioId: radioId || '',
      },
    });
    console.log('Rendering search form with pre-filled query params (if any).');
  } catch (error) {
    console.error('Error rendering search form:', error);
    console.error(error.stack);
    res.status(500).send('Error rendering search form');
  }
});

// --------------- NEW: Talkgroup Type-Ahead endpoint ----------------

// Example approach #1: If your talkgroup IDs are stored in talkgroupConfig.cache
router.get('/search/talkgroups', (req, res) => {
  const term = req.query.term || '';
  if (!term) {
    return res.json([]);
  }

  // Suppose talkgroupConfig.cache is an object like:
  // { "9999": { alphaTag: "145.190MHz", description: "HAM" }, "9989": {...}, ... }
  const allIDs = Object.keys(talkgroupConfig.cache); // e.g. ['9999','9989', '41000'...]

  // Filter talkgroup IDs that contain `term` (case-sensitive or not, up to you)
  // If you want case-insensitive numeric match, you'll probably do includes(term).
  const filtered = allIDs.filter((id) => id.includes(term));

  // Prepare an array of up to 15 results: { decimal, alphaTag }
  const results = filtered.slice(0, 15).map((id) => {
    const entry = talkgroupConfig.cache[id] || {};
    return {
      decimal: id, // the talkgroup ID as string
      alphaTag: entry.alphaTag || '', // or any fallback if alphaTag is missing
    };
  });

  return res.json(results);
});

/*
// Example approach #2: If talkgroup IDs come from a Talkgroup model
router.get('/search/talkgroups', async (req, res) => {
  const term = req.query.term || '';
  if (!term) return res.json([]);

  // E.g. partial match on decimal or alphaTag
  const docs = await Talkgroup.find({
    decimal: { $regex: term, $options: 'i' }
  }).limit(15);

  const results = docs.map(d => d.decimal.toString());
  return res.json(results);
});
*/

module.exports = router;
