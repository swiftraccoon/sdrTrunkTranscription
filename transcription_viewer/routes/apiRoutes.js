/**
 * This module defines the main API routes for handling file uploads and certain
 * user preferences (like toggling autoplay). It includes:
 *  - An /upload route to store transcription text + MP3 files.
 *  - Cache invalidation and rebuilding logic.
 *  - WebSocket notifications for new transcriptions.
 *  - A /toggle-autoplay route to update user autoplay preference in session.
 */

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const Transcription = require('../models/Transcription');

const router = express.Router();
const cacheService = require('../cacheService');
const { wss, broadcastNewTranscription, addToMP3Queue } = require('../webSocketService');
const User = require('../models/User'); // Though not currently used, we keep the import for clarity.
const talkgroupConfig = require('../utils/talkgroupConfig');

/**
 * @function sanitizeTalkgroupId
 * A basic sanitizer for talkgroupId to remove any path-traversal characters.
 * Adjust the allowed characters as needed. For instance, you might allow only digits.
 */
function sanitizeTalkgroupId(tgid) {
  if (!tgid) return null;
  // Only allow alphanumeric, dashes, underscores, or digits. Strip everything else.
  return tgid.replace(/[^a-zA-Z0-9-_]/g, '');
}

/**
 * Generate a unique filename to avoid potential overwrites or collisions.
 * E.g., originalName = transcript.txt -> transcript-<timestamp>.txt
 */
function generateUniqueFilename(originalName) {
  const timestamp = Date.now();
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext);
  return `${base}-${timestamp}${ext}`;
}

// Set up storage configuration for multer
const storage = multer.diskStorage({
  destination(req, file, cb) {
    let { talkgroupId } = req.body;
    talkgroupId = sanitizeTalkgroupId(talkgroupId);

    if (!talkgroupId) {
      // If talkgroupId is invalid or missing, store in a "misc" directory or reject
      const err = new Error('Missing or invalid talkgroupId');
      err.statusCode = 400;
      return cb(err);
    }

    const dir = path.join(__dirname, `../uploads/${talkgroupId}`);

    // Create directory if it doesn't exist
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename(req, file, cb) {
    // Instead of using the original name directly, use a sanitized unique name
    const safeFilename = generateUniqueFilename(file.originalname);
    cb(null, safeFilename);
  },
});

const upload = multer({ storage });

/**
 * Middleware to check API key.
 * Logs only the first 6 characters of the invalid key for security.
 */
const checkApiKey = (req, res, next) => {
  const apiKey = req.get('X-API-Key');
  if (apiKey !== process.env.API_KEY) {
    const displayedKey = apiKey ? apiKey.substring(0, 6) + '...' : 'NONE';
    console.error(`Unauthorized attempt with API key: ${displayedKey}`);
    return res.status(403).send('Unauthorized: Invalid API key');
  }
  console.log('API key validated successfully');
  next();
};

/**
 * Parse a timestamp in format "YYYYMMDD_HHMMSS" into a Date object.
 * Returns null if invalid or cannot parse.
 */
function parseCustomTimestamp(tsString) {
  // Expected length is 15 (8 for date, 1 for underscore, 6 for time)
  // e.g. "20250101_235959"
  if (!tsString || tsString.length !== 15 || tsString.charAt(8) !== '_') {
    return null;
  }
  try {
    const datePart = tsString.slice(0, 8); // YYYYMMDD
    const timePart = tsString.slice(9);    // HHMMSS
    const formattedTimestamp = `${datePart.slice(0, 4)}-${datePart.slice(
      4,
      6
    )}-${datePart.slice(6, 8)}T${timePart.slice(0, 2)}:${timePart.slice(
      2,
      4
    )}:${timePart.slice(4, 6)}`;

    const dateObj = new Date(formattedTimestamp);
    if (isNaN(dateObj.getTime())) {
      return null;
    }
    return dateObj;
  } catch (e) {
    return null;
  }
}

router.post(
  '/upload',
  checkApiKey,
  upload.fields([{ name: 'transcription', maxCount: 1 }, { name: 'mp3', maxCount: 1 }]),
  async (req, res) => {
    let transcriptionPath;
    let mp3Path;
    try {
      const { transcription, mp3 } = req.files || {};
      const { timestamp, radioId } = req.body;
      let { talkgroupId } = req.body;

      talkgroupId = sanitizeTalkgroupId(talkgroupId);
      if (!talkgroupId) {
        console.error('Invalid or missing talkgroupId during upload.');
        return res.status(400).send('Missing or invalid talkgroupId');
      }

      // Ensure both files exist in the request
      if (!transcription || !transcription[0]) {
        console.error('Transcription file missing in the request.');
        return res.status(400).send('No transcription file provided');
      }
      if (!mp3 || !mp3[0]) {
        console.error('MP3 file missing in the request.');
        return res.status(400).send('No MP3 file provided');
      }

      // Parse the custom timestamp
      const parsedDate = parseCustomTimestamp(timestamp);
      if (!parsedDate) {
        console.error(`Invalid timestamp format: ${timestamp}`);
        return res.status(400).send('Invalid timestamp format');
      }

      transcriptionPath = transcription[0].path;
      mp3Path = mp3[0].path;
      const webAccessiblePath = `/uploads/${talkgroupId}/${path.basename(mp3Path)}`;

      // Optional quick check to prevent duplicates
      const existingTranscription = await Transcription.findOne({
        timestamp: parsedDate,
        talkgroupId,
        radioId,
      });
      if (existingTranscription) {
        console.log('Duplicate transcription detected (pre-insert), skipping database insertion (409).');
        // Remove the uploaded files to avoid orphaning
        try {
          await fs.promises.unlink(transcriptionPath);
          await fs.promises.unlink(mp3Path);
        } catch (unlinkErr) {
          console.error('Error removing files after duplicate detection:', unlinkErr);
        }
        return res.status(409).send('Duplicate transcription');
      }

      // Asynchronously read the transcription text
      let transcriptionText;
      try {
        transcriptionText = await fs.promises.readFile(transcriptionPath, 'utf-8');
      } catch (err) {
        console.error('Error reading transcription file:', err);
        // Cleanup files on error
        try {
          await fs.promises.unlink(transcriptionPath);
          await fs.promises.unlink(mp3Path);
        } catch (unlinkErr) {
          console.error('Error removing files after read failure:', unlinkErr);
        }
        return res.status(500).send('Failed to read transcription file');
      }

      // Attempt to create doc
      let newTranscription;
      try {
        newTranscription = await Transcription.create({
          text: transcriptionText,
          mp3FilePath: webAccessiblePath,
          timestamp: parsedDate,
          talkgroupId,
          radioId,
        });
      } catch (err) {
        if (err.code === 11000) {
          console.log('Duplicate transcription blocked by unique index. Returning 409.');
          // Cleanup files on error
          try {
            await fs.promises.unlink(transcriptionPath);
            await fs.promises.unlink(mp3Path);
          } catch (unlinkErr) {
            console.error('Error removing files after DB duplicate error:', unlinkErr);
          }
          return res.status(409).send('Duplicate transcription');
        }
        console.error('Error creating Transcription doc:', err);
        // Cleanup
        try {
          await fs.promises.unlink(transcriptionPath);
          await fs.promises.unlink(mp3Path);
        } catch (unlinkErr) {
          console.error('Error removing files after DB error:', unlinkErr);
        }
        return res.status(500).send('Error during file upload');
      }

      console.log(`New transcription saved: ${newTranscription._id}`);

      // Invalidate cache for all groups
      const groupList = talkgroupConfig.getAllGroups();
      const limit = 30; // The same limit for all
      for (const group of groupList) {
        const cacheKey = `recent_transcriptions_${limit}_${group}`;
        const success = cacheService.invalidateCache(cacheKey);
        if (success) {
          console.log(`Cache invalidated for group='${group}'.`);
        } else {
          console.log(`Failed to invalidate or key not found: ${cacheKey}`);
        }
      }

      // Also invalidate the general 'recent_transcriptions' key
      cacheService.invalidateCache('recent_transcriptions');

      // ------------------------------------------------------
      // Rebuild the group-based cache, *but also ENRICH* each doc
      //    to ensure talkgroupName shows on page load.
      // ------------------------------------------------------
      for (const group of groupList) {
        let query = {};

        // If group === 'All', we fetch all transcriptions
        // otherwise we fetch transcriptions whose talkgroupId is in group
        if (group !== 'All') {
          const groupIds = talkgroupConfig.getGroupIds(group);
          query = { talkgroupId: { $in: groupIds } };
        }

        // Fetch raw
        let groupTranscriptions = await Transcription.find(query)
          .sort({ timestamp: -1 })
          .limit(limit);

        // If you have a "filterTranscriptions" method, call it:
        if (typeof Transcription.filterTranscriptions === 'function') {
          groupTranscriptions = Transcription.filterTranscriptions(groupTranscriptions);
        }

        // "Enrich" the talkgroupName, groupName
        groupTranscriptions = groupTranscriptions.map((t) => {
          const doc = t._doc ? t._doc : t; // handle if it's a plain object
          const grpName = talkgroupConfig.getGroupName(doc.talkgroupId);
          const tgName = talkgroupConfig.getTalkgroupName(doc.talkgroupId);

          return {
            ...doc,
            groupName: grpName || 'Unknown Group',
            talkgroupName: tgName
              ? `${doc.talkgroupId} (${tgName})`
              : `TGID ${doc.talkgroupId}`,
          };
        });

        // Now we store the enriched docs in cache
        cacheService.saveToCache(`recent_transcriptions_${limit}_${group}`, groupTranscriptions);
      }

      // Rebuild the 'recent_transcriptions' cache (the global cache)
      let recentTranscriptions = await Transcription.find({})
        .sort({ timestamp: -1 })
        .limit(limit);

      if (typeof Transcription.filterTranscriptions === 'function') {
        recentTranscriptions = Transcription.filterTranscriptions(recentTranscriptions);
      }

      recentTranscriptions = recentTranscriptions.map((t) => {
        const doc = t._doc ? t._doc : t;
        const grpName = talkgroupConfig.getGroupName(doc.talkgroupId);
        const tgName = talkgroupConfig.getTalkgroupName(doc.talkgroupId);

        return {
          ...doc,
          groupName: grpName || 'Unknown Group',
          talkgroupName: tgName
            ? `${doc.talkgroupId} (${tgName})`
            : `TGID ${doc.talkgroupId}`,
        };
      });

      cacheService.saveToCache('recent_transcriptions', recentTranscriptions);
      console.log('Cache updated with the most recent transcriptions (fully enriched).');

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
      // Attempt to remove files if they exist
      if (transcriptionPath) {
        try {
          await fs.promises.unlink(transcriptionPath);
        } catch (unlinkErr) {
          console.error('Error removing transcription file after outer catch:', unlinkErr);
        }
      }
      if (mp3Path) {
        try {
          await fs.promises.unlink(mp3Path);
        } catch (unlinkErr) {
          console.error('Error removing MP3 file after outer catch:', unlinkErr);
        }
      }
      res.status(500).send('Error during file upload');
    }
  },
);

/**
 * Updated endpoint for toggling autoplay. Requires a valid session.
 * Expects a JSON body: { "autoplay": true/false }
 */
router.post('/toggle-autoplay', (req, res) => {
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