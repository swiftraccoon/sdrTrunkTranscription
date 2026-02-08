jest.mock('../../utils/logger', () => require('../mocks/logger'));
jest.mock('../../models/Subscription');
jest.mock('../../routes/middleware/authMiddleware', () => ({
  isAuthenticated: (req, res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const Subscription = require('../../models/Subscription');

function createApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // Mock session
  app.use((req, res, next) => {
    req.session = { userId: 'test-user-id' };
    req.flash = jest.fn();
    next();
  });

  // Mock view engine
  app.set('view engine', 'ejs');
  app.engine('ejs', (path, data, cb) => cb(null, JSON.stringify(data)));

  const subscriptionRoutes = require('../../routes/subscriptionRoutes');
  app.use('/', subscriptionRoutes);
  return app;
}

describe('Subscription Routes', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApp();
  });

  describe('GET /subscriptions', () => {
    test('renders subscriptions page', async () => {
      Subscription.find.mockResolvedValue([]);

      const res = await request(app).get('/subscriptions');
      expect(res.status).toBe(200);
      expect(Subscription.find).toHaveBeenCalledWith({ userId: 'test-user-id' });
    });
  });

  describe('POST /subscriptions', () => {
    test('creates a subscription', async () => {
      Subscription.prototype.save = jest.fn().mockResolvedValue();
      // Mock the Subscription constructor
      const mockSave = jest.fn().mockResolvedValue();
      Subscription.mockImplementation(() => ({
        save: mockSave,
      }));

      const res = await request(app)
        .post('/subscriptions')
        .send({
          pattern: 'fire', isRegex: 'false', emailNotification: 'false', keepHistory: 'true',
        });

      expect(res.status).toBe(302);
    });

    test('rejects invalid regex pattern', async () => {
      const res = await request(app)
        .post('/subscriptions')
        .send({ pattern: '[invalid', isRegex: 'true' });

      expect(res.status).toBe(302);
    });
  });

  describe('DELETE /subscriptions/:id', () => {
    test('deletes a subscription owned by user', async () => {
      Subscription.deleteOne.mockResolvedValue({ deletedCount: 1 });

      const res = await request(app)
        .delete('/subscriptions/abc123');

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Subscription deleted successfully');
      expect(Subscription.deleteOne).toHaveBeenCalledWith({
        _id: 'abc123',
        userId: 'test-user-id',
      });
    });

    test('returns 404 when subscription not found', async () => {
      Subscription.deleteOne.mockResolvedValue({ deletedCount: 0 });

      const res = await request(app)
        .delete('/subscriptions/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Subscription not found');
    });

    test('returns 500 on database error', async () => {
      Subscription.deleteOne.mockRejectedValue(new Error('DB error'));

      const res = await request(app)
        .delete('/subscriptions/abc123');

      expect(res.status).toBe(500);
    });
  });

  describe('GET /subscriptions/:id/matches', () => {
    test('returns matches for owned subscription', async () => {
      Subscription.findOne.mockResolvedValue({
        matches: [{ text: 'test match', timestamp: new Date() }],
      });

      const res = await request(app)
        .get('/subscriptions/abc123/matches');

      expect(res.status).toBe(200);
      expect(res.body.matches).toHaveLength(1);
    });

    test('returns 404 for non-existent subscription', async () => {
      Subscription.findOne.mockResolvedValue(null);

      const res = await request(app)
        .get('/subscriptions/nonexistent/matches');

      expect(res.status).toBe(404);
    });
  });
});
