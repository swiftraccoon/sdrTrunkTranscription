/**
 * Cache Service
 * 
 * Simple caching service for transcription data with:
 * - TTL-based expiration
 * - Logging via the app's logger (not console.log)
 * - Simple invalidation patterns
 */

const NodeCache = require('node-cache');
const logger = require('./utils/logger');

// Create cache with 60 second TTL by default
// Check for expired keys every 120 seconds
const cache = new NodeCache({ 
  stdTTL: 60,
  checkperiod: 120,
  useClones: false // Don't clone for better performance
});

// Track basic metrics
const metrics = {
  hits: 0,
  misses: 0,
  sets: 0,
  deletes: 0,
};

// Log cache events
cache.on('expired', (key) => {
  logger.debug(`Cache expired: ${key}`);
});

cache.on('flush', () => {
  logger.info('Cache flushed');
});

module.exports = {
  /**
   * Get data from cache
   * @param {string} key - Cache key
   * @returns {any} Cached value or undefined
   */
  getFromCache(key) {
    try {
      const value = cache.get(key);
      if (value === undefined) {
        metrics.misses++;
        logger.debug(`Cache miss for key: ${key}`);
      } else {
        metrics.hits++;
        logger.debug(`Cache hit for key: ${key}`);
      }
      return value;
    } catch (error) {
      logger.error(`Error retrieving from cache for key: ${key}`, {
        error: error.message,
        stack: error.stack
      });
      return undefined;
    }
  },

  /**
   * Save data to cache
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} [ttl] - Optional TTL in seconds (default 60)
   * @returns {boolean} Success status
   */
  saveToCache(key, value, ttl) {
    try {
      const success = ttl ? cache.set(key, value, ttl) : cache.set(key, value);
      if (success) {
        metrics.sets++;
        logger.debug(`Successfully saved to cache for key: ${key}`);
      } else {
        logger.warn(`Failed to save to cache for key: ${key}`);
      }
      return success;
    } catch (error) {
      logger.error(`Error saving to cache for key: ${key}`, {
        error: error.message,
        stack: error.stack
      });
      return false;
    }
  },

  /**
   * Invalidate cache key(s)
   * @param {string|string[]|RegExp} keys - Key(s) to invalidate or pattern
   * @returns {number} Number of keys deleted
   */
  invalidateCache(keys) {
    try {
      let deletedCount = 0;
      
      // Handle pattern-based invalidation (useful for invalidating all group caches)
      if (keys instanceof RegExp) {
        const allKeys = cache.keys();
        const matchingKeys = allKeys.filter(key => keys.test(key));
        
        if (matchingKeys.length > 0) {
          deletedCount = cache.del(matchingKeys);
          metrics.deletes += deletedCount;
          logger.info(`Pattern invalidation deleted ${deletedCount} keys matching ${keys}`);
        }
        return deletedCount;
      }
      
      // Handle array of keys
      if (Array.isArray(keys)) {
        deletedCount = cache.del(keys);
        metrics.deletes += deletedCount;
        logger.debug(`Invalidated ${deletedCount} cache keys`);
        return deletedCount;
      }
      
      // Handle single key
      const success = cache.del(keys);
      if (success) {
        metrics.deletes++;
        logger.debug(`Cache invalidated for key: ${keys}`);
      } else {
        logger.debug(`Cache key not found: ${keys}`);
      }
      return success;
    } catch (error) {
      logger.error(`Error invalidating cache`, {
        keys,
        error: error.message,
        stack: error.stack
      });
      return 0;
    }
  },

  /**
   * Invalidate all transcription caches for all groups
   * This is what happens when a new transcription is uploaded
   */
  invalidateAllTranscriptionCaches() {
    // Invalidate all recent_transcriptions_* keys
    const deleted = this.invalidateCache(/^recent_transcriptions_/);
    logger.info(`Invalidated ${deleted} transcription cache entries`);
    return deleted;
  },

  /**
   * Get cache statistics
   * @returns {Object} Cache statistics
   */
  getStats() {
    const stats = cache.getStats();
    const hitRate = metrics.hits + metrics.misses > 0 
      ? ((metrics.hits / (metrics.hits + metrics.misses)) * 100).toFixed(2)
      : 0;
    
    return {
      ...metrics,
      hitRate: `${hitRate}%`,
      keys: stats.keys,
      hits: stats.hits,
      misses: stats.misses,
      ksize: stats.ksize,
      vsize: stats.vsize
    };
  },

  /**
   * Flush all cache entries
   */
  flushCache() {
    cache.flushAll();
    logger.info('Cache flushed');
  },

  /**
   * Check if key exists
   * @param {string} key - Cache key
   * @returns {boolean} True if key exists
   */
  has(key) {
    return cache.has(key);
  },

  /**
   * Get TTL for a key
   * @param {string} key - Cache key
   * @returns {number|undefined} TTL in milliseconds or undefined
   */
  getTtl(key) {
    return cache.getTtl(key);
  },

  /**
   * Get all cache keys
   * @returns {string[]} Array of cache keys
   */
  keys() {
    return cache.keys();
  },

  /**
   * Close cache and cleanup
   */
  close() {
    cache.close();
    logger.info('Cache closed');
  }
};