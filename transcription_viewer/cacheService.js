const NodeCache = require('node-cache');
// Set up the cache with a standard TTL (time to live) of 1 minute (in seconds)
const cache = new NodeCache({ stdTTL: 60 });

module.exports = {
  // Function to get data from cache
  getFromCache(key) {
    try {
      const value = cache.get(key);
      if (value === undefined) {
        console.log(`Cache miss for key: ${key}`);
      } else {
        console.log(`Cache hit for key: ${key}`);
      }
      return value;
    } catch (error) {
      console.error(`Error retrieving from cache for key: ${key}`, error.stack);
      return undefined;
    }
  },
  // Function to save data to cache
  saveToCache(key, value) {
    try {
      const success = cache.set(key, value);
      if (success) {
        console.log(`Successfully saved to cache for key: ${key}`);
      } else {
        console.log(`Failed to save to cache for key: ${key}`);
      }
      return success;
    } catch (error) {
      console.error(`Error saving to cache for key: ${key}`, error.stack);
      return false;
    }
  },
  // Function to invalidate cache key
  invalidateCache(key) {
    try {
      const success = cache.del(key);
      if (success) {
        console.log(`Cache invalidated for key: ${key}`);
      } else {
        console.log(`Failed to invalidate cache for key: ${key}. Key might not exist.`);
      }
    } catch (error) {
      console.error(`Error invalidating cache for key: ${key}`, error.stack);
    }
  },
};
