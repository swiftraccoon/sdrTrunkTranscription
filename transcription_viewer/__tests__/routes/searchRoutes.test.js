jest.mock('../../utils/logger', () => require('../mocks/logger'));
jest.mock('../../models/Transcription');
jest.mock('../../utils/talkgroupConfig', () => ({
  getAllGroups: jest.fn(() => ['All', 'Fire', 'EMS']),
  getGroupIds: jest.fn((group) => {
    if (group === 'Fire') return ['100', '101'];
    if (group === 'EMS') return ['200', '201'];
    return [];
  }),
  cache: {
    100: { alphaTag: 'Fire Dispatch' },
    200: { alphaTag: 'EMS Dispatch' },
  },
}));

const express = require('express');
const request = require('supertest');
const Transcription = require('../../models/Transcription');

function createApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // Mock session
  app.use((req, res, next) => {
    req.session = { userId: 'test-user', userTier: 'registered' };
    next();
  });

  // Mock view engine
  app.set('view engine', 'ejs');
  app.engine('ejs', (path, data, cb) => {
    cb(null, JSON.stringify(data));
  });

  // Mock authMiddleware - we're testing search logic, not auth
  jest.mock('../../routes/middleware/authMiddleware', () => ({
    isAuthenticated: (req, res, next) => next(),
    tierAccessControl: (req, res, next) => next(),
  }));

  const searchRoutes = require('../../routes/searchRoutes');
  app.use('/', searchRoutes);
  return app;
}

describe('Search Routes', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApp();
  });

  describe('GET /search', () => {
    test('searches with plain keyword', async () => {
      const mockSort = jest.fn().mockResolvedValue([]);
      Transcription.find.mockReturnValue({ sort: mockSort });

      await request(app)
        .get('/search')
        .query({ keyword: 'fire' });

      expect(Transcription.find).toHaveBeenCalledWith(
        expect.objectContaining({
          text: { $regex: 'fire', $options: 'i' },
        }),
      );
    });

    test('escapes regex special characters in keyword', async () => {
      const mockSort = jest.fn().mockResolvedValue([]);
      Transcription.find.mockReturnValue({ sort: mockSort });

      await request(app)
        .get('/search')
        .query({ keyword: 'test.*[dangerous]' });

      const calledQuery = Transcription.find.mock.calls[0][0];
      // The regex metacharacters should be escaped
      expect(calledQuery.text.$regex).toBe('test\\.\\*\\[dangerous\\]');
    });

    test('escapes parentheses and plus signs', async () => {
      const mockSort = jest.fn().mockResolvedValue([]);
      Transcription.find.mockReturnValue({ sort: mockSort });

      await request(app)
        .get('/search')
        .query({ keyword: 'test(+)' });

      const calledQuery = Transcription.find.mock.calls[0][0];
      expect(calledQuery.text.$regex).toBe('test\\(\\+\\)');
    });

    test('filters by date range', async () => {
      const mockSort = jest.fn().mockResolvedValue([]);
      Transcription.find.mockReturnValue({ sort: mockSort });

      await request(app)
        .get('/search')
        .query({ startDate: '2025-01-01', endDate: '2025-01-31' });

      const calledQuery = Transcription.find.mock.calls[0][0];
      expect(calledQuery.timestamp).toBeDefined();
      expect(calledQuery.timestamp.$gte).toBeInstanceOf(Date);
      expect(calledQuery.timestamp.$lte).toBeInstanceOf(Date);
    });

    test('filters by group when no specific talkgroupId', async () => {
      const mockSort = jest.fn().mockResolvedValue([]);
      Transcription.find.mockReturnValue({ sort: mockSort });
      const talkgroupConfig = require('../../utils/talkgroupConfig');

      await request(app)
        .get('/search')
        .query({ group: 'Fire' });

      expect(talkgroupConfig.getGroupIds).toHaveBeenCalledWith('Fire');
      const calledQuery = Transcription.find.mock.calls[0][0];
      expect(calledQuery.talkgroupId).toEqual({ $in: ['100', '101'] });
    });

    test('talkgroupId takes precedence over group', async () => {
      const mockSort = jest.fn().mockResolvedValue([]);
      Transcription.find.mockReturnValue({ sort: mockSort });

      await request(app)
        .get('/search')
        .query({ group: 'Fire', talkgroupId: '999' });

      const calledQuery = Transcription.find.mock.calls[0][0];
      expect(calledQuery.talkgroupId).toBe('999');
    });

    test('returns 500 on database error', async () => {
      const mockSort = jest.fn().mockRejectedValue(new Error('DB error'));
      Transcription.find.mockReturnValue({ sort: mockSort });

      const res = await request(app)
        .get('/search')
        .query({ keyword: 'test' });

      expect(res.status).toBe(500);
    });
  });

  describe('GET /search/talkgroups', () => {
    test('returns empty array with no term', async () => {
      const res = await request(app)
        .get('/search/talkgroups')
        .query({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    test('filters talkgroup IDs by term', async () => {
      const res = await request(app)
        .get('/search/talkgroups')
        .query({ term: '100' });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });
});
