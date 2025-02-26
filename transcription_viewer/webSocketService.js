/**
 * WebSocket Service
 * 
 * This module handles real-time communication between the server and clients.
 * It manages WebSocket connections, audio playback queues, transcription broadcasts,
 * and subscription notifications.
 * 
 * The service provides the following features:
 * - Real-time transcription updates to connected clients
 * - Audio playback queue management with autoplay functionality
 * - Subscription matching for keyword alerts
 * - Connection management with heartbeat monitoring
 */

const WebSocket = require('ws');
// const cacheService = require('./cacheService'); // Removed unused import
const Transcription = require('./models/Transcription');
const Subscription = require('./models/Subscription');
const emailService = require('./services/emailService');
const logger = require('./utils/logger');
const { fetchLatestTranscriptions } = require('./utils/fetchLatestTranscriptions');
const talkgroupConfig = require('./utils/talkgroupConfig');

// Create a WebSocket server
const wss = new WebSocket.Server({ noServer: true });

// Store MP3 queues per user to prevent one user consuming another's queue
const userMP3Queues = {};

// Track each user's autoplay preference
const userAutoplayPreferences = {};

// Track currently playing audio for each user to prevent duplicates
const currentlyPlaying = {};

// Store subscription cache to reduce database queries
let subscriptionCache = [];
let subscriptionCacheTime = 0;
const SUBSCRIPTION_CACHE_TTL = 60000; // 1 minute

/**
 * Heartbeat function to keep track of connection status
 */
function heartbeat() {
  this.isAlive = true;
}

/**
 * Send a message to a WebSocket client with error handling
 * @param {WebSocket} ws - The WebSocket connection
 * @param {Object} data - The data to send
 * @param {string} userId - The user ID for logging
 */
function sendMessage(ws, data, userId) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data), (err) => {
      if (err) {
        logger.error(`Error sending message to client ${userId}: ${err.message}`, err.stack);
      }
    });
  }
}

// WebSocket connection handler
wss.on('connection', (ws, request) => {
  const { userId } = request.session;
  logger.info(`WebSocket connection attempt for user ${userId} with Session ID: ${request.session.id}`);

  if (!userId) {
    logger.error('WebSocket connection refused due to unauthorized user (no userId).');
    ws.close(4001, 'Unauthorized');
    return;
  }

  // Initialize user data
  ws.userId = userId;
  ws.isAlive = true;
  ws.messageCount = 0;
  ws.lastMessageTime = Date.now();
  
  // Initialize user's MP3 queue if it doesn't exist
  if (!userMP3Queues[userId]) {
    userMP3Queues[userId] = [];
  }
  
  // Set autoplay preference
  userAutoplayPreferences[userId] = request.session.autoplay || false;

  // Immediately send autoplay status
  sendMessage(ws, {
    action: 'autoplayStatus',
    autoplay: userAutoplayPreferences[userId],
  }, userId);

  // Send the latest transcriptions
  fetchLatestTranscriptions()
    .then((transcriptions) => {
      sendMessage(ws, { 
        action: 'latestTranscriptions', 
        data: transcriptions 
      }, userId);
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

  // Set up heartbeat
  ws.on('pong', heartbeat);

  // Handle incoming messages
  ws.on('message', (message) => {
    // Simple rate limiting
    const now = Date.now();
    if (now - ws.lastMessageTime < 100) { // Minimum 100ms between messages
      ws.messageCount++;
      if (ws.messageCount > 50) { // If more than 50 rapid messages
        logger.warn(`Rate limit exceeded for user ${userId}, closing connection`);
        ws.close(4000, 'Rate limit exceeded');
        return;
      }
    } else {
      ws.messageCount = 0;
      ws.lastMessageTime = now;
    }

    logger.info(`Received message: ${message} (userId=${userId} session=${request.session.id})`);
    
    try {
      const parsedMessage = JSON.parse(message);

      // Validate message structure
      if (!parsedMessage.action) {
        logger.warn(`Invalid message format from user ${userId}: missing action`);
        return;
      }

      // Handle autoplay status update
      if (parsedMessage.action === 'autoplayStatus') {
        if (typeof parsedMessage.autoplay !== 'boolean') {
          logger.warn(`Invalid autoplay value from user ${userId}`);
          return;
        }
        
        userAutoplayPreferences[userId] = parsedMessage.autoplay;
        logger.info(
          `Autoplay status updated for user=${userId}, newStatus=${parsedMessage.autoplay}`
        );
      }

      // Handle next audio request
      if (parsedMessage.action === 'requestNextAudio') {
        if (userAutoplayPreferences[userId]) {
          const userQueue = userMP3Queues[userId];
          
          if (userQueue && userQueue.length > 0) {
            const nextItem = userQueue[0]; // { path, talkgroupId }
            
            // Make sure not to send the exact same item they are already playing
            if (currentlyPlaying[userId] !== nextItem.path) {
              // Remove from queue using splice for better performance with small arrays
              userQueue.splice(0, 1);
              currentlyPlaying[userId] = nextItem.path;

              // Send talkgroupId along with path
              sendMessage(ws, {
                action: 'nextAudio',
                path: nextItem.path,
                talkgroupId: nextItem.talkgroupId,
              }, userId);

              logger.info(
                `Sending nextAudio to user=${userId}, path=${nextItem.path}, TGID=${nextItem.talkgroupId}`
              );
            } else {
              logger.info(`User ${userId} is already playing ${nextItem.path}, noMoreAudio sent.`);
              sendMessage(ws, { action: 'noMoreAudio' }, userId);
            }
          } else {
            logger.info(`No audio in queue for user=${userId}, sending noMoreAudio.`);
            sendMessage(ws, { action: 'noMoreAudio' }, userId);
          }
        }
      }
    } catch (error) {
      logger.error(`Error parsing message from user ${userId}: ${error.message}`);
    }
  });

  // Handle disconnection
  ws.on('close', () => {
    // Clean up user resources
    delete userAutoplayPreferences[userId];
    delete currentlyPlaying[userId];
    // Keep the queue in case they reconnect soon
    setTimeout(() => {
      if (!wss.clients.some(client => client.userId === userId)) {
        delete userMP3Queues[userId];
      }
    }, 300000); // Clean up queue after 5 minutes if not reconnected
    
    logger.info(`WebSocket connection closed for user ${userId}`);
  });
});

// Periodically ping clients to ensure they're alive
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Clean up interval on server close
wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

/**
 * Filter out unwanted patterns from transcriptions
 * @param {Array} transcriptions - Array of transcription objects
 * @returns {Array} Filtered array of transcriptions
 */
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

/**
 * Get cached subscriptions or refresh from database
 * @returns {Promise<Array>} Array of subscription objects
 */
async function getSubscriptions() {
  const now = Date.now();
  if (now - subscriptionCacheTime > SUBSCRIPTION_CACHE_TTL || subscriptionCache.length === 0) {
    try {
      subscriptionCache = await Subscription.find({});
      subscriptionCacheTime = now;
    } catch (error) {
      logger.error('Error fetching subscriptions for cache:', error);
      // Return existing cache if fetch fails
      return subscriptionCache;
    }
  }
  return subscriptionCache;
}

/**
 * Check user subscriptions for keyword matches, sending email if needed
 * @param {Object} transcription - The transcription object to check
 */
async function checkSubscriptionMatches(transcription) {
  try {
    const subscriptions = await getSubscriptions();
    
    for (const subscription of subscriptions) {
      let isMatch = false;

      if (subscription.isRegex) {
        try {
          // Limit regex complexity to prevent ReDoS attacks
          if (subscription.pattern.length > 100) {
            logger.warn(`Skipping overly complex regex in subscription=${subscription._id}`);
            continue;
          }
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
        
        // Update the cache
        subscriptionCacheTime = 0; // Force refresh on next check
      }
    }
  } catch (error) {
    logger.error('Error checking subscription matches:', error);
  }
}

/**
 * Broadcast a brand-new transcription to all clients
 * @param {Object} newTranscription - The new transcription to broadcast
 */
async function broadcastNewTranscription(newTranscription) {
  await checkSubscriptionMatches(newTranscription);

  // Skip if older than 3 hours
  const threeHoursAgo = Date.now() - (3 * 60 * 60 * 1000);
  
  // Use proper timezone handling with UTC
  const transcriptionTimestamp = new Date(newTranscription.timestamp);
  if (transcriptionTimestamp.getTime() < threeHoursAgo) {
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

  const message = {
    action: 'newTranscription',
    data: enrichedTranscription,
  };

  // Broadcast to all connected clients
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.userId) {
      sendMessage(client, message, client.userId);
      logger.info(`Broadcasted new transcription to user ${client.userId}`);
    }
  });
}

/**
 * Add an MP3 file to the playback queue for users with autoplay enabled
 * @param {string} mp3FilePath - Path to the MP3 file
 * @param {string|number} talkgroupId - The talkgroup ID associated with the audio
 */
function addToMP3Queue(mp3FilePath, talkgroupId) {
  const audioItem = { path: mp3FilePath, talkgroupId };
  
  // Add to each user's queue if they have autoplay enabled
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.userId) {
      const userId = client.userId;
      
      // Initialize queue if it doesn't exist
      if (!userMP3Queues[userId]) {
        userMP3Queues[userId] = [];
      }
      
      // Check if it's already in the user's queue
      const userQueue = userMP3Queues[userId];
      const alreadyInQueue = userQueue.some((item) => item.path === mp3FilePath);
      
      if (!alreadyInQueue) {
        // Add to user's queue
        userQueue.push(audioItem);
        logger.info(`Added path=${mp3FilePath} talkgroupId=${talkgroupId} to user=${userId} playback queue.`);
        
        // Notify user if they have autoplay enabled
        if (userAutoplayPreferences[userId]) {
          sendMessage(client, {
            action: 'nextAudio',
            path: mp3FilePath,
            talkgroupId,
          }, userId);
          
          logger.info(`Notified user=${userId} about new audio (TGID=${talkgroupId}).`);
        }
      }
    }
  });
}

module.exports = {
  wss,
  /**
   * Set up WebSocket server with session handling
   * @param {Object} server - HTTP server instance
   * @param {Function} sessionParser - Express session parser middleware
   */
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
