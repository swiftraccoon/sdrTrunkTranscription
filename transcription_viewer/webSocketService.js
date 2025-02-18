const WebSocket = require('ws');
const cacheService = require('./cacheService'); // Assuming correct path to cacheService
const Transcription = require('./models/Transcription'); // Import the Transcription model
const Subscription = require('./models/Subscription');
const emailService = require('./services/emailService');
const logger = require('./utils/logger'); // Import the logger utility
const { fetchLatestTranscriptions } = require('./utils/fetchLatestTranscriptions');
const talkgroupConfig = require('./utils/talkgroupConfig');

// Create a WebSocket server
const wss = new WebSocket.Server({ noServer: true });

// Create an array to act as a queue for MP3 file paths
const mp3PlaybackQueue = [];

// Map to track user autoplay preferences
const userAutoplayPreferences = {};

// Variable to track currently playing audio for each user
const currentlyPlaying = {};

function heartbeat() {
  this.isAlive = true;
}

wss.on('connection', (ws, request) => {
  const { userId } = request.session;

  logger.info(`WebSocket connection attempt for user ${userId} with Session ID: ${request.session.id}`);

  if (!userId) {
    logger.error('WebSocket connection refused due to unauthorized user.');
    ws.close(4001, 'Unauthorized');
    return;
  }

  ws.userId = userId; // Assign userId to ws object for later reference
  userAutoplayPreferences[userId] = request.session.autoplay || false;

  // Send a single autoplay status message
  ws.send(JSON.stringify({ 
    action: 'autoplayStatus', 
    autoplay: userAutoplayPreferences[userId] 
  }));

  // Fetch and send the latest transcriptions to the newly connected client
  fetchLatestTranscriptions()
    .then((transcriptions) => {
      ws.send(JSON.stringify({ action: 'latestTranscriptions', data: transcriptions }));
    })
    .catch((err) => {
      logger.error('Failed to fetch latest transcriptions for WebSocket client:', err.message, err.stack);
    });

  logger.info(
    `WebSocket connection established for user ${userId}. `
    + `Session ID: ${request.session.id} `
    + `Autoplay preference: ${userAutoplayPreferences[userId]}`,
  );

  // Heartbeat for ping/pong
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  // Handle incoming messages from the client
  ws.on('message', (message) => {
    logger.info(`Received message: ${message} from user ${userId} Session ID: ${request.session.id}`);
    const parsedMessage = JSON.parse(message);

    if (parsedMessage.action === 'autoplayStatus') {
      userAutoplayPreferences[ws.userId] = parsedMessage.autoplay;
      logger.info(
        `Autoplay status updated for user ${ws.userId} Session ID: ${request.session.id}. `
        + `New status: ${parsedMessage.autoplay}`,
      );
    }

    if (parsedMessage.action === 'requestNextAudio' && userAutoplayPreferences[ws.userId]) {
      if (mp3PlaybackQueue.length > 0 && currentlyPlaying[userId] !== mp3PlaybackQueue[0]) {
        currentlyPlaying[userId] = mp3PlaybackQueue.shift();
        ws.send(JSON.stringify({ type: 'nextAudio', path: currentlyPlaying[userId] }));
        logger.info(`Sending next audio path: ${currentlyPlaying[userId]} to user ${userId}.`);
      } else {
        logger.info(`No audio in queue to send to user ${userId}.`);
        ws.send(JSON.stringify({ type: 'noMoreAudio' }));
      }
    }
  });

  // Send current autoplay status once again
  ws.send(JSON.stringify({ action: 'autoplayStatus', autoplay: request.session.autoplay }));
  logger.info('Sent current autoplay status to client.');
});

// Periodically ping clients to ensure they're still alive
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

/**
 * filterTranscriptions:
 * We define unwanted patterns to exclude certain trivial or noisy lines.
 * - Repetitions of "BANG" or "BANG!" e.g. "BANG BANG!" "BANG! BANG!" etc.
 * - "Thank you" with optional punctuation at end (., !)
 * - Lines made entirely of periods/spaces (like "...", ". . .", etc.)
 */
function filterTranscriptions(transcriptions) {
  // Improved unwanted patterns:
  const unwantedPatterns = [
    // 1) One or more "BANG" or "BANG!" only (case-insensitive),
    //    possibly separated by spaces. e.g. "BANG BANG", "BANG! BANG!"
    // We'll allow optional leading/trailing spaces as well.
    // Explanation:
    // ^\s*     optional leading spaces
    // (?:BANG!?)(?:\s+BANG!?)*   at least one BANG or BANG! plus optional repeated
    // \s*$     optional trailing spaces
    /^ *(?:BANG!?)(?:\s+BANG!?)* *$/i,
    /^ *(?:BOOM!?)(?:\s+BOOM!?)* *$/i,

    // 2) "Thank you" + optional punctuation (. or !) and optional trailing spaces
    // e.g. "Thank you", "Thank you.", "thank you!!!"
    // We'll only allow period or exclamation:
    /^ *thank you[.!]* *$/i,

    // 3) Lines of only periods and/or spaces, e.g. ".", "..", ". .", "....", etc.
    // Possibly with some trailing spaces.
    // e.g. "..." or "   . . ."
    /^[.\s]+$/,
  ];

  return transcriptions.filter(({ text }) =>
    // Return true if it does NOT match any unwanted pattern
    !unwantedPatterns.some((regex) => regex.test(text)));
}

async function checkSubscriptionMatches(transcription) {
  try {
    const subscriptions = await Subscription.find({});
    
    for (const subscription of subscriptions) {
      let isMatch = false;
      
      if (subscription.isRegex) {
        try {
          const regex = new RegExp(subscription.pattern);
          isMatch = regex.test(transcription.text);
        } catch (error) {
          logger.error(`Invalid regex pattern in subscription ${subscription._id}:`, error);
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

        // Add to matches if keepHistory is true
        if (subscription.keepHistory) {
          subscription.matches.push(match);
          if (subscription.matches.length > 15) {
            subscription.matches = subscription.matches.slice(-15);
          }
        }

        // Send email notification if enabled
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

async function broadcastNewTranscription(newTranscription) {
  // Check for subscription matches first
  await checkSubscriptionMatches(newTranscription);

  // 1) Check if older than 3 hours
  const threeHoursAgo = Date.now() - (3 * 60 * 60 * 1000);
  const timestampStr = String(newTranscription.timestamp);
  const localTimestamp = timestampStr.replace(/Z$/, '');
  const docTime = new Date(`${localTimestamp} GMT-0500`).getTime();
  if (docTime < threeHoursAgo) {
    logger.info(`threeHoursAgo: ${threeHoursAgo}`);
    logger.info(`docTime: ${docTime}`);
    logger.info(
      'Skipping broadcast for old transcription (older than 3h). '
      + `Timestamp: ${newTranscription.timestamp}`,
    );
    return;
  }

  // 2) Filter out unwanted patterns
  const filtered = filterTranscriptions([newTranscription]);
  if (filtered.length === 0) {
    logger.info('Filtered out unwanted transcription. No broadcast necessary.');
    return;
  }

  // 3) Enrich with group name, talkgroup name
  const transcription = filtered[0];
  const groupName = talkgroupConfig.getGroupName(transcription.talkgroupId);
  const talkgroupName = talkgroupConfig.getTalkgroupName(transcription.talkgroupId);

  const enrichedTranscription = {
    ...transcription._doc,
    groupName: groupName || 'Unknown Group',
    talkgroupName: talkgroupName
      ? `${transcription.talkgroupId} (${talkgroupName})`
      : `TGID ${transcription.talkgroupId}`,
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
      logger.info(`Broadcasted new transcription to user ${client.userId}.`);
    }
  });
}

/**
 * addToMP3Queue:
 * Add the MP3 path to the playback queue, then notify clients with autoplay enabled.
 * Also includes talkgroupId in the 'nextAudio' message, so the client can skip if out-of-group.
 */
function addToMP3Queue(mp3FilePath, talkgroupId) {
  if (!mp3PlaybackQueue.includes(mp3FilePath)) {
    mp3PlaybackQueue.push(mp3FilePath);
    logger.info(`Added MP3 file path ${mp3FilePath} to playback queue.`);

    // Now notify all clients with autoplay enabled
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && userAutoplayPreferences[client.userId]) {
        client.send(
          JSON.stringify({
            action: 'nextAudio',
            path: mp3FilePath,
            talkgroupId,
          }),
        );
        logger.info(
          `Notified user ${client.userId} about new audio file for autoplay. talkgroupId=${talkgroupId}`,
        );
      }
    });
  } else {
    logger.info(`MP3 file path ${mp3FilePath} is already in playback queue.`);
  }
}

module.exports = {
  wss,
  setupWebSocket: (server, sessionParser) => {
    server.on('upgrade', (request, socket, head) => {
      logger.info('Attempting to upgrade connection to WebSocket...');

      sessionParser(request, {}, () => {
        if (!request.session.userId) {
          logger.warn('WebSocket upgrade refused: user not authenticated.');
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
