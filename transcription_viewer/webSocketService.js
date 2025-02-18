const WebSocket = require('ws');
const cacheService = require('./cacheService');
const Transcription = require('./models/Transcription');
const Subscription = require('./models/Subscription');
const emailService = require('./services/emailService');
const logger = require('./utils/logger');
const { fetchLatestTranscriptions } = require('./utils/fetchLatestTranscriptions');
const talkgroupConfig = require('./utils/talkgroupConfig');

// Create a WebSocket server
const wss = new WebSocket.Server({ noServer: true });

// Instead of storing just mp3 file paths, store objects with { path, talkgroupId }
const mp3PlaybackQueue = [];

// Track each user's autoplay preference
const userAutoplayPreferences = {};

// Track currently playing audio for each user to prevent duplicates
const currentlyPlaying = {};

function heartbeat() {
  this.isAlive = true;
}

wss.on('connection', (ws, request) => {
  const { userId } = request.session;
  logger.info(`WebSocket connection attempt for user ${userId} with Session ID: ${request.session.id}`);

  if (!userId) {
    logger.error('WebSocket connection refused due to unauthorized user (no userId).');
    ws.close(4001, 'Unauthorized');
    return;
  }

  ws.userId = userId;
  userAutoplayPreferences[userId] = request.session.autoplay || false;

  // Immediately send autoplay status
  ws.send(JSON.stringify({
    action: 'autoplayStatus',
    autoplay: userAutoplayPreferences[userId],
  }));

  // Also send the latest transcriptions if needed
  fetchLatestTranscriptions()
    .then((transcriptions) => {
      ws.send(JSON.stringify({ action: 'latestTranscriptions', data: transcriptions }));
    })
    .catch((err) => {
      logger.error(
        'Failed to fetch latest transcriptions for WebSocket client:',
        err.message,
        err.stack
      );
    });

  logger.info(
    `WebSocket connection established for user ${userId}. `
    + `Session ID: ${request.session.id}, `
    + `autoplay=${userAutoplayPreferences[userId]}`
  );

  // Heartbeat
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  // Handle incoming messages
  ws.on('message', (message) => {
    logger.info(`Received message: ${message} (userId=${userId} session=${request.session.id})`);
    const parsedMessage = JSON.parse(message);

    // If the client updates autoplay status
    if (parsedMessage.action === 'autoplayStatus') {
      userAutoplayPreferences[ws.userId] = parsedMessage.autoplay;
      logger.info(
        `Autoplay status updated for user=${ws.userId}, newStatus=${parsedMessage.autoplay}`
      );
    }

    // Client requesting next audio
    if (parsedMessage.action === 'requestNextAudio' && userAutoplayPreferences[ws.userId]) {
      if (mp3PlaybackQueue.length > 0) {
        const nextItem = mp3PlaybackQueue[0]; // { path, talkgroupId }
        // Make sure not to send the exact same item they are already playing
        if (currentlyPlaying[userId] !== nextItem.path) {
          mp3PlaybackQueue.shift(); // remove from queue
          currentlyPlaying[userId] = nextItem.path;

          // Send talkgroupId along with path
          ws.send(JSON.stringify({
            action: 'nextAudio',
            path: nextItem.path,
            talkgroupId: nextItem.talkgroupId,
          }));

          logger.info(
            `Sending nextAudio to user=${userId}, path=${nextItem.path}, TGID=${nextItem.talkgroupId}`
          );
        } else {
          logger.info(`User ${userId} is already playing ${nextItem.path}, noMoreAudio sent.`);
          ws.send(JSON.stringify({ action: 'noMoreAudio' }));
        }
      } else {
        logger.info(`No audio in queue for user=${userId}, sending noMoreAudio.`);
        ws.send(JSON.stringify({ action: 'noMoreAudio' }));
      }
    }
  });

  // Send autoplay status once again (optional, can remove if redundant)
  ws.send(JSON.stringify({ action: 'autoplayStatus', autoplay: request.session.autoplay }));
  logger.info('Sent current autoplay status to client.');
});

// Periodically ping clients to ensure they're alive
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Filter out unwanted patterns, e.g. repeated "BANG" lines, "Thank you", etc.
function filterTranscriptions(transcriptions) {
  const unwantedPatterns = [
    /^ *(?:BANG!?)(?:\s+BANG!?)* *$/i,
    /^ *(?:BOOM!?)(?:\s+BOOM!?)* *$/i,
    /^ *thank you[.!]* *$/i,
    /^[.\s]+$/,
  ];

  return transcriptions.filter(({ text }) => {
    return !unwantedPatterns.some((regex) => regex.test(text));
  });
}

// Check user subscriptions for keyword matches, sending email if needed
async function checkSubscriptionMatches(transcription) {
  try {
    const subscriptions = await Subscription.find({});
    for (const subscription of subscriptions) {
      let isMatch = false;

      if (subscription.isRegex) {
        try {
          const regex = new RegExp(subscription.pattern);
          isMatch = regex.test(transcription.text);
        } catch (err) {
          logger.error(`Invalid regex in subscription=${subscription._id}`, err);
          continue;
        }
      } else {
        isMatch = transcription.text.toLowerCase().includes(subscription.pattern.toLowerCase());
      }

      if (isMatch) {
        const match = {
          transcriptionId: transcription._id,
          timestamp: transcription.timestamp,
          text: transcription.text
        };

        if (subscription.keepHistory) {
          subscription.matches.push(match);
          if (subscription.matches.length > 15) {
            subscription.matches = subscription.matches.slice(-15);
          }
        }

        if (subscription.emailNotification && subscription.email) {
          await emailService.sendNotification(subscription.email, match);
        }

        subscription.lastNotified = new Date();
        await subscription.save();
      }
    }
  } catch (error) {
    logger.error('Error checking subscription matches:', error);
  }
}

// Broadcast a brand-new transcription to all clients (if it isn't too old or filtered out)
async function broadcastNewTranscription(newTranscription) {
  await checkSubscriptionMatches(newTranscription);

  // Skip if older than 3 hours
  const threeHoursAgo = Date.now() - (3 * 60 * 60 * 1000);
  const docTime = new Date(String(newTranscription.timestamp).replace(/Z$/, '') + ' GMT-0500').getTime();
  if (docTime < threeHoursAgo) {
    logger.info(
      `Skipping broadcast for old transcription (older than 3h). t=${newTranscription.timestamp}`
    );
    return;
  }

  // Filter out "unwanted" single-word lines, "BANG," etc.
  const filtered = filterTranscriptions([newTranscription]);
  if (filtered.length === 0) {
    logger.info('Filtered out unwanted transcription, not broadcasting.');
    return;
  }

  // Enrich talkgroup info
  const transcription = filtered[0];
  const groupName = talkgroupConfig.getGroupName(transcription.talkgroupId) || 'Unknown Group';
  const tgName = talkgroupConfig.getTalkgroupName(transcription.talkgroupId);
  const talkgroupName = tgName
    ? `${transcription.talkgroupId} (${tgName})`
    : `TGID ${transcription.talkgroupId}`;

  const enrichedTranscription = {
    ...transcription._doc,
    groupName,
    talkgroupName,
  };

  const message = JSON.stringify({
    action: 'newTranscription',
    data: enrichedTranscription,
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.userId) {
      client.send(message, (err) => {
        if (err) {
          logger.error(`Error sending new transcription to client ${client.userId}: ${err.message}`, err.stack);
        }
      });
      logger.info(`Broadcasted new transcription to user ${client.userId}`);
    }
  });
}

/**
 * addToMP3Queue:
 * Called whenever a new MP3 is uploaded. We store { path, talkgroupId } in `mp3PlaybackQueue`,
 * then broadcast "nextAudio" to any user who has autoplay turned on.
 */
function addToMP3Queue(mp3FilePath, talkgroupId) {
  // Check if it's already in the queue
  const alreadyInQueue = mp3PlaybackQueue.some((item) => item.path === mp3FilePath);
  if (!alreadyInQueue) {
    // Store both path and talkgroup
    mp3PlaybackQueue.push({ path: mp3FilePath, talkgroupId });
    logger.info(`Added path=${mp3FilePath} talkgroupId=${talkgroupId} to the playback queue.`);

    // Broadcast "nextAudio" to all clients who have autoplay on
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && userAutoplayPreferences[client.userId]) {
        client.send(
          JSON.stringify({
            action: 'nextAudio',
            path: mp3FilePath,
            talkgroupId,
          })
        );
        logger.info(`Notified user=${client.userId} about new audio (TGID=${talkgroupId}).`);
      }
    });
  } else {
    logger.info(`MP3 path=${mp3FilePath} is already in the playback queue; skipping.`);
  }
}

module.exports = {
  wss,
  setupWebSocket: (server, sessionParser) => {
    server.on('upgrade', (request, socket, head) => {
      logger.info('Attempting to upgrade connection to WebSocket...');

      sessionParser(request, {}, () => {
        if (!request.session.userId) {
          logger.warn('WebSocket upgrade refused: no user authenticated.');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
          logger.info('WebSocket connection successfully upgraded.');
        });
      });
    });
  },
  broadcastNewTranscription,
  addToMP3Queue,
};
