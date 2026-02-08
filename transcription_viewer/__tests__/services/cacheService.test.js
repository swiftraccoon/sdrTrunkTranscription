jest.mock('../../utils/logger', () => require('../mocks/logger'));

const cacheService = require('../../cacheService');

beforeEach(() => {
  cacheService.flushCache();
});

afterAll(() => {
  cacheService.close();
});

describe('cacheService', () => {
  describe('getFromCache / saveToCache', () => {
    test('returns undefined for missing key', () => {
      expect(cacheService.getFromCache('nonexistent')).toBeUndefined();
    });

    test('saves and retrieves a value', () => {
      cacheService.saveToCache('key1', { data: 'hello' });
      expect(cacheService.getFromCache('key1')).toEqual({ data: 'hello' });
    });

    test('saves with custom TTL', () => {
      const result = cacheService.saveToCache('ttl-key', 'value', 300);
      expect(result).toBe(true);
      expect(cacheService.getFromCache('ttl-key')).toBe('value');
    });

    test('overwrites existing value', () => {
      cacheService.saveToCache('key1', 'old');
      cacheService.saveToCache('key1', 'new');
      expect(cacheService.getFromCache('key1')).toBe('new');
    });
  });

  describe('invalidateCache', () => {
    test('invalidates a single key', () => {
      cacheService.saveToCache('del-key', 'value');
      const deleted = cacheService.invalidateCache('del-key');
      expect(deleted).toBe(1);
      expect(cacheService.getFromCache('del-key')).toBeUndefined();
    });

    test('returns 0 for non-existent key', () => {
      expect(cacheService.invalidateCache('nope')).toBe(0);
    });

    test('invalidates an array of keys', () => {
      cacheService.saveToCache('a', 1);
      cacheService.saveToCache('b', 2);
      cacheService.saveToCache('c', 3);
      const deleted = cacheService.invalidateCache(['a', 'b']);
      expect(deleted).toBe(2);
      expect(cacheService.getFromCache('a')).toBeUndefined();
      expect(cacheService.getFromCache('b')).toBeUndefined();
      expect(cacheService.getFromCache('c')).toBe(3);
    });

    test('invalidates by regex pattern', () => {
      cacheService.saveToCache('recent_transcriptions_30_All', []);
      cacheService.saveToCache('recent_transcriptions_30_EMS', []);
      cacheService.saveToCache('other_key', 'keep');
      const deleted = cacheService.invalidateCache(/^recent_transcriptions_/);
      expect(deleted).toBe(2);
      expect(cacheService.getFromCache('other_key')).toBe('keep');
    });
  });

  describe('has', () => {
    test('returns false for missing key', () => {
      expect(cacheService.has('missing')).toBe(false);
    });

    test('returns true for existing key', () => {
      cacheService.saveToCache('exists', true);
      expect(cacheService.has('exists')).toBe(true);
    });
  });

  describe('keys', () => {
    test('returns all cache keys', () => {
      cacheService.saveToCache('x', 1);
      cacheService.saveToCache('y', 2);
      const keys = cacheService.keys();
      expect(keys).toContain('x');
      expect(keys).toContain('y');
    });
  });

  describe('getStats', () => {
    test('returns stats object with expected fields', () => {
      cacheService.saveToCache('s', 1);
      cacheService.getFromCache('s');
      cacheService.getFromCache('miss');
      const stats = cacheService.getStats();
      expect(stats).toHaveProperty('hitRate');
      expect(stats).toHaveProperty('keys');
      expect(stats).toHaveProperty('hits');
      expect(stats).toHaveProperty('misses');
    });
  });

  describe('flushCache', () => {
    test('removes all keys', () => {
      cacheService.saveToCache('f1', 1);
      cacheService.saveToCache('f2', 2);
      cacheService.flushCache();
      expect(cacheService.keys()).toHaveLength(0);
    });
  });

  describe('invalidateAllTranscriptionCaches', () => {
    test('invalidates all recent_transcriptions_* keys', () => {
      cacheService.saveToCache('recent_transcriptions_30_All', []);
      cacheService.saveToCache('recent_transcriptions_30_Fire', []);
      cacheService.saveToCache('unrelated', 'keep');
      const deleted = cacheService.invalidateAllTranscriptionCaches();
      expect(deleted).toBe(2);
      expect(cacheService.getFromCache('unrelated')).toBe('keep');
    });
  });
});
