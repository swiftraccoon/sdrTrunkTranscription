jest.mock('../../utils/logger', () => require('../mocks/logger'));
jest.mock('mongoose', () => ({
  connection: { readyState: 1 },
  connect: jest.fn().mockResolvedValue(),
  Schema: jest.fn().mockReturnValue({
    index: jest.fn(),
    pre: jest.fn(),
    post: jest.fn(),
    statics: {},
  }),
  model: jest.fn().mockReturnValue({}),
}));
jest.mock('../../models/Talkgroup', () => ({}));

// We test the singleton instance's methods directly.
// Each describe block uses jest.resetModules() for isolation.

describe('TalkgroupConfig', () => {
  let config;

  beforeEach(() => {
    // Clear and re-require to get fresh instance
    jest.resetModules();
    jest.mock('../../utils/logger', () => require('../mocks/logger'));
    jest.mock('mongoose', () => ({
      connection: { readyState: 1 },
      connect: jest.fn().mockResolvedValue(),
      Schema: jest.fn().mockReturnValue({
        index: jest.fn(),
        pre: jest.fn(),
        post: jest.fn(),
        statics: {},
      }),
      model: jest.fn().mockReturnValue({}),
    }));
    jest.mock('../../models/Talkgroup', () => ({}));

    config = require('../../utils/talkgroupConfig');
  });

  describe('parseGroupRanges', () => {
    test('parses single values', () => {
      const result = config.parseGroupRanges('100,200,300');
      expect(result).toEqual([100, 200, 300]);
    });

    test('parses ranges', () => {
      const result = config.parseGroupRanges('1-3');
      expect(result).toEqual([1, 2, 3]);
    });

    test('parses mixed singles and ranges', () => {
      const result = config.parseGroupRanges('5,10-12,20');
      expect(result).toEqual([5, 10, 11, 12, 20]);
    });

    test('handles empty string', () => {
      expect(config.parseGroupRanges('')).toEqual([]);
    });

    test('handles null/undefined', () => {
      expect(config.parseGroupRanges(null)).toEqual([]);
      expect(config.parseGroupRanges(undefined)).toEqual([]);
    });

    test('skips invalid non-numeric values', () => {
      const result = config.parseGroupRanges('abc,5,xyz');
      expect(result).toEqual([5]);
    });
  });

  describe('getTalkgroupName', () => {
    test('returns fallback for unknown ID', () => {
      expect(config.getTalkgroupName(99999)).toBe('TGID 99999');
    });

    test('returns alphaTag (description) when both exist', () => {
      config.cache['100'] = {
        alphaTag: 'Fire Dispatch',
        description: 'County Fire',
      };
      expect(config.getTalkgroupName(100)).toBe('Fire Dispatch (County Fire)');
    });

    test('returns description alone when no alphaTag', () => {
      config.cache['200'] = { description: 'EMS', alphaTag: null };
      expect(config.getTalkgroupName(200)).toBe('EMS');
    });

    test('returns alphaTag alone when no description', () => {
      config.cache['300'] = { alphaTag: 'PD Main', description: null };
      expect(config.getTalkgroupName(300)).toBe('PD Main');
    });

    test('returns fallback when cache entry has neither', () => {
      config.cache['400'] = { alphaTag: null, description: null };
      expect(config.getTalkgroupName(400)).toBe('TGID 400');
    });
  });

  describe('getGroupName', () => {
    test('returns null for unknown talkgroup', () => {
      config.groups = {};
      expect(config.getGroupName(99999)).toBeNull();
    });

    test('returns group name when talkgroup is in a group', () => {
      config.groups = { Fire: [100, 101, 102] };
      expect(config.getGroupName(101)).toBe('Fire');
    });

    test('returns null for NaN input', () => {
      expect(config.getGroupName('abc')).toBeNull();
    });
  });

  describe('getAllGroups', () => {
    test('returns All plus configured groups', () => {
      config.groups = { Fire: [], EMS: [] };
      const groups = config.getAllGroups();
      expect(groups[0]).toBe('All');
      expect(groups).toContain('Fire');
      expect(groups).toContain('EMS');
    });
  });

  describe('getGroupIds', () => {
    test('returns stringified IDs for a group', () => {
      config.groups = { Fire: [100, 101, 102] };
      const ids = config.getGroupIds('Fire');
      expect(ids).toEqual(['100', '101', '102']);
    });

    test('returns empty array for unknown group', () => {
      expect(config.getGroupIds('Unknown')).toEqual([]);
    });
  });
});
