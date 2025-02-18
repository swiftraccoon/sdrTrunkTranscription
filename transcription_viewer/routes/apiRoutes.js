const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const Transcription = require('../models/Transcription');

const router = express.Router();
const cacheService = require('../cacheService');
const { wss, broadcastNewTranscription, addToMP3Queue } = require('../webSocketService');
const User = require('../models/User');
const talkgroupConfig = require('../utils/talkgroupConfig');

// Set up storage configuration for multer
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const { talkgroupId } = req.body;
    const dir = path.join(__dirname, `../uploads/${talkgroupId}`);

    // Create directory if it doesn't exist
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename(req, file, cb) {
    cb(null, file.originalname);
  },
});

const upload = multer({ storage });

// Middleware to check API key
const checkApiKey = (req, res, next) => {
  const apiKey = req.get('X-API-Key');
  if (apiKey !== process.env.API_KEY) {
    console.error(`Unauthorized attempt with API key: ${apiKey}`);
    return res.status(403).send('Unauthorized: Invalid API key');
  }
  console.log('API key validated successfully');
  next();
};

router.post(
  '/api/upload',
  checkApiKey,
  upload.fields([{ name: 'transcription', maxCount: 1 }, { name: 'mp3', maxCount: 1 }]),
  async (req, res) => {
    try {
      const { transcription, mp3 } = req.files;
      const { timestamp, talkgroupId, radioId } = req.body;

      // Parse timestamp "YYYYMMDD_HHMMSS" -> "YYYY-MM-DDTHH:MM:SS"
      const datePart = timestamp.slice(0, 8);
      const timePart = timestamp.slice(9);
      const formattedTimestamp = `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(
        6,
        8,
      )}T${timePart.slice(0, 2)}:${timePart.slice(2, 4)}:${timePart.slice(4, 6)}`;

      const transcriptionPath = transcription[0].path;
      const mp3Path = mp3[0].path;
      // Example: "/uploads/9999/somefile.mp3"
      const webAccessiblePath = `/uploads/${talkgroupId}/${path.basename(mp3Path)}`;

      // Optional quick check to prevent duplicates
      const existingTranscription = await Transcription.findOne({
        timestamp: new Date(formattedTimestamp),
        talkgroupId,
        radioId,
      });
      if (existingTranscription) {
        console.log('Duplicate transcription detected, skipping database insertion (409).');
        return res.status(409).send('Duplicate transcription');
      }

      // Create document
      let newTranscription;
      try {
        newTranscription = await Transcription.create({
          text: fs.readFileSync(transcriptionPath, 'utf-8'), // synchronous read
          mp3FilePath: webAccessiblePath,
          timestamp: new Date(formattedTimestamp),
          talkgroupId,
          radioId,
        });
      } catch (err) {
        if (err.code === 11000) {
          console.log('Duplicate transcription blocked by unique index. Returning 409.');
          return res.status(409).send('Duplicate transcription');
        }
        console.error('Error creating Transcription doc:', err);
        return res.status(500).send('Error during file upload');
      }

      console.log(`New transcription saved: ${newTranscription._id}`);

      // Invalidate cache for all groups
      const groupList = talkgroupConfig.getAllGroups();
      const limit = 30;

      for (const group of groupList) {
        const cacheKey = `recent_transcriptions_${limit}_${group}`;
        const success = cacheService.invalidateCache(cacheKey);
        if (success) {
          console.log(`Cache invalidated for group='${group}'.`);
        } else {
          console.log(`Failed to invalidate or key not found: ${cacheKey}`);
        }
      }

      // Also invalidate the general 'recent_transcriptions' key (if used)
      cacheService.invalidateCache('recent_transcriptions');

      // ------------------------------------------------------
      // Rebuild each group's cache. We do the same logic as in indexRoutes:
      //   if group === 'All', we .find({}).
      //   else we find docs whose talkgroupId is in that group's ID array.
      // ------------------------------------------------------
      for (const group of groupList) {
        let query = {};

        if (group !== 'All') {
          // talkgroupConfig.getGroupIds(group) must return an array
          // of talkgroupIds that belong to this group
          const groupIds = talkgroupConfig.getGroupIds(group);
          query = { talkgroupId: { $in: groupIds } };
        }
        // If group === 'All', query remains {}

        const groupTranscriptions = await Transcription.find(query)
          .sort({ timestamp: -1 })
          .limit(limit);

        cacheService.saveToCache(`recent_transcriptions_${limit}_${group}`, groupTranscriptions);
      }

      // Optionally, rebuild your global "recent_transcriptions" cache
      // with the top 30 sitewide
      const recentTranscriptions = await Transcription.find({})
        .sort({ timestamp: -1 })
        .limit(limit);

      cacheService.saveToCache('recent_transcriptions', recentTranscriptions);

      console.log('Cache updated with the most recent transcriptions (including "All").');

      // Notify connected clients about the new doc
      broadcastNewTranscription(newTranscription);

      // Add the MP3 file path to the autoplay queue
      addToMP3Queue(webAccessiblePath, talkgroupId);
      console.log(
        `Added MP3 file path ${webAccessiblePath} to playback queue and notified users with autoplay enabled.`,
      );

      res.status(201).send('Upload successful');
    } catch (error) {
      console.error('Error uploading files (outer catch):', error);
      console.error(error.stack);
      res.status(500).send('Error during file upload');
    }
  },
);

// Updated endpoint for toggling autoplay
router.post('/api/toggle-autoplay', (req, res) => {
  if (!req.session || !req.session.userId) {
    console.error('Error updating autoplay preference: session or userId not found.');
    return res.status(401).send('Unauthorized');
  }

  const newAutoplayValue = req.body.autoplay === true;
  req.session.autoplay = newAutoplayValue;
  console.log(`Autoplay preference updated to ${newAutoplayValue} for user ${req.session.userId}`);

  // Update the WebSocket service's state
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.userId === req.session.userId) {
      client.send(
        JSON.stringify({
          action: 'autoplayStatus',
          autoplay: newAutoplayValue,
        }),
      );
    }
  });

  res.json({
    success: true,
    message: 'Autoplay preference updated successfully.',
    autoplay: newAutoplayValue,
  });
});

module.exports = router;
