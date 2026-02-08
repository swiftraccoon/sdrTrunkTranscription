/**
 * @file aiRoutes.js
 * @description Express router for AI-related routes (querying OpenAI/Google LLMs).
 */

const express = require('express');

const router = express.Router();
const { isAuthenticated, tierAccessControl } = require('./middleware/authMiddleware');

const { initializeLLMClient, generateLLMResponse } = require('../public/js/llmClient');
const { buildContextFromTranscriptions } = require('../public/js/contextBuilder');
const { getModelContextLength } = require('../public/js/modelContextHelper');

// Models
const Transcription = require('../models/Transcription');
const LLMInteraction = require('../models/LLMInteraction');

/**
 * POST /ai/query
 * Gathers transcriptions in a date range, builds context, and queries the specified LLM.
 *
 * Security note: The API key is provided per-request by the user ("bring your own key").
 * It must never be logged, persisted, or included in error responses.
 */
router.post('/ai/query', isAuthenticated, tierAccessControl, async (req, res) => {
  const {
    query, apiKey, llmService, modelName, startDate, endDate, tgidsFilter
  } = req.body;

  if (!apiKey || !llmService || !modelName) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    // Initialize LLM client & get max token context length
    const client = initializeLLMClient(llmService, apiKey);
    const maxTokens = getModelContextLength(llmService, modelName);

    // Parse dates and ensure they're valid
    const startDateTime = new Date(startDate);
    const endDateTime = new Date(endDate);

    if (isNaN(startDateTime.getTime()) || isNaN(endDateTime.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    // Process tgidsFilter
    let tgids = [];
    if (tgidsFilter && tgidsFilter.trim() !== '') {
      tgids = tgidsFilter.split(',').map(item => item.trim());
    }

    // Fetch transcriptions within the specified date range
    let transcriptionFilter = {
      timestamp: {
        $gte: startDateTime,
        $lte: endDateTime,
      }
    };
    if (tgids.length > 0) {
      transcriptionFilter.tgid = { $in: tgids };
    }
    const transcriptions = await Transcription.find(transcriptionFilter).sort({ timestamp: 1 });

    // Build the context from transcriptions
    const context = buildContextFromTranscriptions(transcriptions, maxTokens);

    // Append user's question
    const fullPrompt = `${context}\nBased on these transcriptions, please answer the following question:\n${query}`;

    // Generate response using the LLM
    const answer = await generateLLMResponse(llmService, client, modelName, fullPrompt);

    // Save the interaction
    await LLMInteraction.create({
      userId: req.session.userId,
      llmService,
      modelName,
      prompt: fullPrompt,
      response: answer,
      startDate: startDateTime,
      endDate: endDateTime,
      transcriptionCount: transcriptions.length,
    });

    console.log('AI Response:', answer);
    return res.json({ answer });
  } catch (error) {
    console.error('Error processing AI request:', error);
    return res.status(500).json({ error: error.message || 'Failed to get response from AI.' });
  }
});

/**
 * GET /ai
 * Renders the AI interaction page.
 */
router.get('/ai', isAuthenticated, tierAccessControl, (req, res) => {
  res.render('ai');
});

/**
 * GET /ai/history
 * Returns the user's LLM interaction history
 */
router.get('/ai/history', isAuthenticated, async (req, res) => {
  try {
    const interactions = await LLMInteraction.find({ userId: req.session.userId })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(interactions);
  } catch (error) {
    console.error('Error fetching LLM history:', error);
    res.status(500).json({ error: 'Failed to fetch LLM history' });
  }
});

module.exports = router;
