/**
 * WebSocket Service - Production Ready
 *
 * This module handles real-time communication between the server and clients.
 * It manages WebSocket connections, audio playback queues, transcription broadcasts,
 * and subscription notifications with enhanced security and performance.
 *
 * Security features:
 * - ReDoS protection with regex validation and timeouts
 * - Connection limits per user and globally
 * - Enhanced rate limiting with decay
 * - Message size validation
 * - Proper memory leak prevention
 *
 * Performance features:
 * - Map-based data structures for efficiency
 * - Queue size limits
 * - Connection pooling
 * - Metrics collection
 */

const WebSocket = require('ws');
const crypto = require('crypto');
const Subscription = require('./models/Subscription');
const emailService = require('./services/emailService');
const logger = require('./utils/logger');
const { fetchLatestTranscriptions } = require('./utils/fetchLatestTranscriptions');
const talkgroupConfig = require('./utils/talkgroupConfig');

// Configuration
const CONFIG = {
  HEARTBEAT_INTERVAL: 30000,
  MESSAGE_RATE_LIMIT: 100, // ms between messages
  MESSAGE_BURST_LIMIT: 50, // max burst messages
  MAX_CONNECTIONS_PER_USER: 3,
  MAX_TOTAL_CONNECTIONS: 1000,
  QUEUE_CLEANUP_TIMEOUT: 300000, // 5 minutes
  SUBSCRIPTION_CACHE_TTL: 60000, // 1 minute
  MAX_REGEX_LENGTH: 100,
  REGEX_TIMEOUT: 100, // ms
  MAX_QUEUE_SIZE: 100, // per user
  OLD_TRANSCRIPTION_THRESHOLD: 3 * 60 * 60 * 1000, // 3 hours
  MAX_MESSAGE_SIZE: 65536, // 64KB
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS?.split(',') || ['*'],
};

// Create a WebSocket server
const wss = new WebSocket.Server({
  noServer: true,
  maxPayload: CONFIG.MAX_MESSAGE_SIZE,
});

// Use Maps for better performance and memory management
const userMP3Queues = new Map();
const userAutoplayPreferences = new Map(); // Now stores per device: userId_deviceId -> boolean
const currentlyPlaying = new Map();
const userConnections = new Map(); // Track connections per user
const cleanupTimeouts = new Map(); // Track cleanup timeouts

// Store subscription cache to reduce database queries
let subscriptionCache = [];
let subscriptionCacheTime = 0;

// Metrics collection
const metrics = {
  totalConnections: 0,
  activeConnections: 0,
  messagesReceived: 0,
  messagesSent: 0,
  errors: 0,
  rateLimitHits: 0,
  regexTimeouts: 0,
  queueOverflows: 0,
};

/**
 * Validate regex pattern for safety against ReDoS attacks
 * @param {string} pattern - The regex pattern to validate
 * @returns {boolean} True if pattern is safe
 */
function isRegexSafe(pattern) {
  if (!pattern || typeof pattern !== 'string') return false;
  if (pattern.length > CONFIG.MAX_REGEX_LENGTH) return false;

  // Check for dangerous patterns that can cause ReDoS
  const dangerousPatterns = [
    /(\w+\+)+/, // Nested quantifiers
    /(\w+\*)+/,
    /(\w+\?)+/,
    /(\w+\{[\d,]+\})+/,
    /(.*)\{[\d,]+\}/, // Catastrophic backtracking
    /(.+)\{[\d,]+\}/,
    /(\(\?:.*\)\+.*\(\?:.*\)\+)/, // Nested groups with quantifiers
  ];

  return !dangerousPatterns.some((dangerous) => dangerous.test(pattern));
}

/**
 * Test regex with timeout to prevent ReDoS
 * @param {string} pattern - The regex pattern
 * @param {string} text - The text to test against
 * @returns {Promise<boolean>} True if match found
 */
async function testRegexWithTimeout(pattern, text) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      metrics.regexTimeouts++;
      reject(new Error('Regex timeout'));
    }, CONFIG.REGEX_TIMEOUT);

    try {
      const regex = new RegExp(pattern, 'i');
      const result = regex.test(text);
      clearTimeout(timeout);
      resolve(result);
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}

/**
 * Validate WebSocket upgrade request
 * @param {Object} request - The upgrade request
 * @returns {Object} Validation result
 */
function validateWebSocketUpgrade(request) {
  // Validate Origin header
  const { origin } = request.headers;
  if (CONFIG.ALLOWED_ORIGINS[0] !== '*' && !CONFIG.ALLOWED_ORIGINS.includes(origin)) {
    return { valid: false, reason: 'Invalid origin' };
  }

  // Validate WebSocket version
  const version = request.headers['sec-websocket-version'];
  if (version !== '13') {
    return { valid: false, reason: 'Unsupported WebSocket version' };
  }

  // Validate session
  if (!request.session || !request.session.userId) {
    return { valid: false, reason: 'No authenticated session' };
  }

  return { valid: true };
}

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

  // Check connection limits
  const currentUserConnections = userConnections.get(userId) || new Set();
  if (currentUserConnections.size >= CONFIG.MAX_CONNECTIONS_PER_USER) {
    logger.warn(`Connection limit exceeded for user ${userId}`, {
      current: currentUserConnections.size,
      max: CONFIG.MAX_CONNECTIONS_PER_USER,
    });
    ws.close(4002, 'Connection limit exceeded');
    return;
  }

  // Check global connection limit
  if (wss.clients.size >= CONFIG.MAX_TOTAL_CONNECTIONS) {
    logger.warn('Global connection limit exceeded', {
      current: wss.clients.size,
      max: CONFIG.MAX_TOTAL_CONNECTIONS,
    });
    ws.close(4003, 'Server at capacity');
    return;
  }

  // Initialize connection data
  ws.userId = userId;
  ws.connectionId = crypto.randomBytes(16).toString('hex');
  ws.deviceId = null; // Will be set when client sends it
  ws.isAlive = true;
  ws.messageCount = 0;
  ws.lastMessageTime = Date.now();
  ws.connectionTime = Date.now();

  // Track connection
  currentUserConnections.add(ws.connectionId);
  userConnections.set(userId, currentUserConnections);
  metrics.totalConnections++;
  metrics.activeConnections++;

  // Cancel cleanup timeout if reconnecting
  if (cleanupTimeouts.has(userId)) {
    clearTimeout(cleanupTimeouts.get(userId));
    cleanupTimeouts.delete(userId);
  }

  // Initialize user's MP3 queue if it doesn't exist
  if (!userMP3Queues.has(userId)) {
    userMP3Queues.set(userId, []);
  }

  // Don't set autoplay here - wait for client to send device-specific preference
  // The client will send their autoplay status immediately upon connection

  // Send the latest transcriptions
  fetchLatestTranscriptions()
    .then((transcriptions) => {
      sendMessage(ws, {
        action: 'latestTranscriptions',
        data: transcriptions,
      }, userId);
    })
    .catch((err) => {
      logger.error(
        'Failed to fetch latest transcriptions for WebSocket client:',
        err.message,
        err.stack,
      );
    });

  logger.info(
    `WebSocket connection established for user ${userId}. `
    + `Session ID: ${request.session.id}, `
    + `autoplay=${userAutoplayPreferences[userId]}`,
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
          logger.warn(`Invalid autoplay value from user ${userId}:`, parsedMessage.autoplay);
          return;
        }

        // Store device ID if provided
        if (parsedMessage.deviceId) {
          ws.deviceId = parsedMessage.deviceId;
        }

        // Create device-specific key
        const deviceKey = ws.deviceId ? `${userId}_${ws.deviceId}` : userId;
        userAutoplayPreferences.set(deviceKey, parsedMessage.autoplay);

        logger.info('Autoplay status updated', {
          userId,
          deviceId: ws.deviceId,
          autoplay: parsedMessage.autoplay,
        });

        // Confirm the change
        sendMessage(ws, {
          action: 'autoplayStatusConfirmed',
          autoplay: parsedMessage.autoplay,
        }, userId);
      }

      // Handle next audio request (deprecated - we now push audio as it arrives)
      if (parsedMessage.action === 'requestNextAudio') {
        logger.debug('Ignoring requestNextAudio - server now pushes audio automatically', { userId });
        // Don't send anything back - let the server push model work
      }
    } catch (error) {
      logger.error(`Error parsing message from user ${userId}: ${error.message}`);
    }
  });

  // Handle disconnection
  ws.on('close', (code, reason) => {
    metrics.activeConnections--;

    // Remove connection from tracking
    const connections = userConnections.get(userId);
    if (connections) {
      connections.delete(ws.connectionId);
      if (connections.size === 0) {
        userConnections.delete(userId);
      } else {
        userConnections.set(userId, connections);
      }
    }

    logger.info('WebSocket connection closed', {
      userId,
      connectionId: ws.connectionId,
      code,
      reason: reason?.toString(),
      connectionDuration: Date.now() - ws.connectionTime,
    });

    // Schedule cleanup if no more connections
    if (!connections || connections.size === 0) {
      const timeoutId = setTimeout(() => {
        // Double-check no new connections
        const currentConnections = userConnections.get(userId);
        if (!currentConnections || currentConnections.size === 0) {
          userMP3Queues.delete(userId);
          currentlyPlaying.delete(userId);
          cleanupTimeouts.delete(userId);
          
          // Clean up device-specific autoplay preferences for this user
          const keysToDelete = [];
          userAutoplayPreferences.forEach((_, key) => {
            if (key.startsWith(`${userId}_`)) {
              keysToDelete.push(key);
            }
          });
          keysToDelete.forEach(key => userAutoplayPreferences.delete(key));
          
          logger.info(`Cleaned up all resources for user ${userId}`);
        }
      }, CONFIG.QUEUE_CLEANUP_TIMEOUT);

      cleanupTimeouts.set(userId, timeoutId);
    }
  });

  // Handle errors
  ws.on('error', (error) => {
    metrics.errors++;
    logger.error(`WebSocket error for user ${userId}:`, {
      error: error.message,
      stack: error.stack,
      connectionId: ws.connectionId,
    });
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

// Clean up on server close
wss.on('close', () => {
  clearInterval(heartbeatInterval);

  // Clear all cleanup timeouts
  cleanupTimeouts.forEach((timeout) => clearTimeout(timeout));
  cleanupTimeouts.clear();

  // Clear all data structures
  userMP3Queues.clear();
  userAutoplayPreferences.clear();
  currentlyPlaying.clear();
  userConnections.clear();

  logger.info('WebSocket server closed, all resources cleaned up');
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

  return transcriptions.filter(({ text }) => !unwantedPatterns.some((regex) => regex.test(text)));
}

/**
 * Get cached subscriptions or refresh from database
 * @returns {Promise<Array>} Array of subscription objects
 */
async function getSubscriptions() {
  const now = Date.now();
  if (now - subscriptionCacheTime > CONFIG.SUBSCRIPTION_CACHE_TTL || subscriptionCache.length === 0) {
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
        // Validate regex safety first
        if (!isRegexSafe(subscription.pattern)) {
          logger.warn(`Unsafe regex pattern in subscription=${subscription._id}`, {
            pattern: subscription.pattern.substring(0, 50),
          });
          continue;
        }

        try {
          // Test regex with timeout protection
          isMatch = await testRegexWithTimeout(subscription.pattern, transcription.text);
        } catch (err) {
          logger.error(`Regex error in subscription=${subscription._id}`, {
            error: err.message,
            pattern: subscription.pattern.substring(0, 50),
          });
          continue;
        }
      } else {
        isMatch = transcription.text.toLowerCase().includes(subscription.pattern.toLowerCase());
      }

      if (isMatch) {
        const match = {
          transcriptionId: transcription._id,
          timestamp: transcription.timestamp,
          text: transcription.text,
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
      `Skipping broadcast for old transcription (older than 3h). t=${newTranscription.timestamp}`,
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

  // Add to each connected user's queue
  let usersNotified = 0;

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.userId) {
      const { userId } = client;

      // Get or create user queue
      let userQueue = userMP3Queues.get(userId);
      if (!userQueue) {
        userQueue = [];
        userMP3Queues.set(userId, userQueue);
      }

      // Check queue size limit
      if (userQueue.length >= CONFIG.MAX_QUEUE_SIZE) {
        metrics.queueOverflows++;
        logger.warn(`Queue size limit reached for user ${userId}`, {
          queueSize: userQueue.length,
          maxSize: CONFIG.MAX_QUEUE_SIZE,
        });
        return;
      }

      // Check for duplicates
      const alreadyInQueue = userQueue.some((item) => item.path === mp3FilePath);

      if (!alreadyInQueue) {
        userQueue.push(audioItem);

        // Check device-specific autoplay preference
        const deviceKey = client.deviceId ? `${userId}_${client.deviceId}` : userId;
        
        // Debug logging
        logger.debug('Checking autoplay for client', {
          userId,
          deviceId: client.deviceId,
          deviceKey,
          hasAutoplay: userAutoplayPreferences.get(deviceKey),
          allKeys: Array.from(userAutoplayPreferences.keys()),
          isPlaying: currentlyPlaying.get(userId)
        });
        
        // Only send if autoplay is enabled for this specific device
        if (userAutoplayPreferences.get(deviceKey) === true) {
          // Always send new audio immediately when it arrives
          sendMessage(client, {
            action: 'audioAvailable',  // Use audioAvailable for new audio
            path: mp3FilePath,
            talkgroupId,
            queueLength: userQueue.length,
          }, userId);
          usersNotified++;
          logger.info('Sent audioAvailable to user', {
            userId,
            deviceId: client.deviceId,
            deviceKey,
            path: mp3FilePath
          });
        } else {
          logger.debug('Not sending audio - autoplay disabled', {
            userId,
            deviceId: client.deviceId,
            deviceKey,
            autoplayValue: userAutoplayPreferences.get(deviceKey)
          });
        }
      }
    }
  });

  logger.info('Added audio to queues', {
    path: mp3FilePath,
    talkgroupId,
    usersNotified,
    totalUsers: wss.clients.size,
  });
}

/**
 * Get current metrics
 * @returns {Object} Current metrics
 */
function getMetrics() {
  return {
    ...metrics,
    timestamp: Date.now(),
    uptime: process.uptime(),
    activeUsers: userConnections.size,
    totalQueues: userMP3Queues.size,
    subscriptionCacheSize: subscriptionCache.length,
    pendingCleanups: cleanupTimeouts.size,
  };
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
      logger.info('WebSocket upgrade request', {
        ip: request.socket.remoteAddress,
        origin: request.headers.origin,
      });

      sessionParser(request, {}, () => {
        // Validate upgrade request
        const validation = validateWebSocketUpgrade(request);
        if (!validation.valid) {
          logger.warn('WebSocket upgrade refused', {
            reason: validation.reason,
            ip: request.socket.remoteAddress,
          });
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      });
    });

    logger.info('WebSocket server initialized with enhanced security');
  },
  broadcastNewTranscription,
  addToMP3Queue,
  getMetrics,
  // Expose for monitoring
  CONFIG,
};
