jest.mock('../../utils/logger', () => require('../mocks/logger'));
jest.mock('../../models/Transcription');
jest.mock('../../models/User');
jest.mock('../../cacheService', () => ({
  invalidateCache: jest.fn().mockReturnValue(1),
  saveToCache: jest.fn().mockReturnValue(true),
}));
jest.mock('../../webSocketService', () => ({
  wss: { clients: new Set() },
  broadcastNewTranscription: jest.fn(),
  addToMP3Queue: jest.fn(),
}));
jest.mock('../../utils/talkgroupConfig', () => ({
  getAllGroups: jest.fn(() => ['All']),
  getGroupIds: jest.fn(() => []),
  getGroupName: jest.fn(),
  getTalkgroupName: jest.fn(),
  cache: {},
}));

const express = require('express');
const request = require('supertest');

// Set API key for tests
process.env.API_KEY = 'test-api-key';

function createApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // Mock session
  app.use((req, res, next) => {
    req.session = { userId: 'test-user-id' };
    next();
  });

  const apiRoutes = require('../../routes/apiRoutes');
  app.use('/api', apiRoutes);
  return app;
}

describe('API Routes', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApp();
  });

  describe('API Key check', () => {
    test('rejects request without API key', async () => {
      const res = await request(app)
        .post('/api/upload');

      expect(res.status).toBe(403);
      expect(res.text).toContain('Unauthorized');
    });

    test('rejects request with wrong API key', async () => {
      const res = await request(app)
        .post('/api/upload')
        .set('X-API-Key', 'wrong-key');

      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/toggle-autoplay', () => {
    test('returns 401 without session', async () => {
      // Create app without session
      const noSessionApp = express();
      noSessionApp.use(express.json());
      noSessionApp.use((req, res, next) => {
        req.session = null;
        next();
      });
      const apiRoutes = require('../../routes/apiRoutes');
      noSessionApp.use('/api', apiRoutes);

      const res = await request(noSessionApp)
        .post('/api/toggle-autoplay')
        .send({ autoplay: true });

      expect(res.status).toBe(401);
    });

    test('updates autoplay preference', async () => {
      const res = await request(app)
        .post('/api/toggle-autoplay')
        .send({ autoplay: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.autoplay).toBe(true);
    });

    test('sets autoplay to false for non-boolean input', async () => {
      const res = await request(app)
        .post('/api/toggle-autoplay')
        .send({ autoplay: 'yes' });

      expect(res.status).toBe(200);
      expect(res.body.autoplay).toBe(false);
    });
  });
});
