jest.mock('../../utils/logger', () => require('../mocks/logger'));
jest.mock('../../models/User');

const express = require('express');
const request = require('supertest');
const bcrypt = require('bcrypt');
const User = require('../../models/User');

function createApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // Mock session middleware
  app.use((req, res, next) => {
    if (!req.session) {
      req.session = {};
    }
    req.session.regenerate = req.session.regenerate || ((cb) => cb(null));
    req.session.destroy = req.session.destroy || ((cb) => cb(null));
    next();
  });

  // Mock view engine
  app.set('view engine', 'ejs');
  app.engine('ejs', (path, data, cb) => cb(null, 'rendered'));

  const authRoutes = require('../../routes/authRoutes');
  app.use('/auth', authRoutes);
  return app;
}

describe('Auth Routes', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApp();
  });

  describe('POST /auth/register', () => {
    test('rejects short username', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ username: 'ab', password: 'password123' });

      expect(res.status).toBe(400);
      expect(res.text).toContain('3-30 alphanumeric');
    });

    test('rejects short password', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ username: 'validuser', password: 'short' });

      expect(res.status).toBe(400);
      expect(res.text).toContain('at least 8');
    });

    test('rejects username with special characters', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ username: 'user@name', password: 'password123' });

      expect(res.status).toBe(400);
    });

    test('creates user with valid input', async () => {
      User.create.mockResolvedValue({ _id: '123', username: 'validuser' });

      const res = await request(app)
        .post('/auth/register')
        .send({ username: 'validuser', password: 'password123' });

      expect(res.status).toBe(302);
      expect(User.create).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'validuser',
          tier: 'registered',
        }),
      );
    });

    test('returns 500 on database error', async () => {
      User.create.mockRejectedValue(new Error('DB error'));

      const res = await request(app)
        .post('/auth/register')
        .send({ username: 'validuser', password: 'password123' });

      expect(res.status).toBe(500);
      expect(res.text).toBe('Registration failed');
    });
  });

  describe('POST /auth/login', () => {
    test('returns generic error for non-existent user', async () => {
      User.findOne.mockResolvedValue(null);

      const res = await request(app)
        .post('/auth/login')
        .send({ username: 'nouser', password: 'password123' });

      expect(res.status).toBe(400);
      expect(res.text).toBe('Invalid username or password');
    });

    test('returns generic error for wrong password', async () => {
      const hashedPass = await bcrypt.hash('correctpass', 10);
      User.findOne.mockResolvedValue({
        _id: '123',
        username: 'testuser',
        password: hashedPass,
        tier: 'registered',
      });

      const res = await request(app)
        .post('/auth/login')
        .send({ username: 'testuser', password: 'wrongpass1' });

      expect(res.status).toBe(400);
      expect(res.text).toBe('Invalid username or password');
    });

    test('returns same error for bad user and bad password', async () => {
      User.findOne.mockResolvedValue(null);
      const res1 = await request(app)
        .post('/auth/login')
        .send({ username: 'baduser', password: 'password123' });

      const hashedPass = await bcrypt.hash('realpass1', 10);
      User.findOne.mockResolvedValue({
        _id: '123',
        username: 'realuser',
        password: hashedPass,
        tier: 'registered',
      });
      const res2 = await request(app)
        .post('/auth/login')
        .send({ username: 'realuser', password: 'wrongpass1' });

      expect(res1.text).toBe(res2.text);
    });

    test('rejects login with invalid username format', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ username: 'x', password: 'password123' });

      expect(res.status).toBe(400);
    });

    test('rejects login with short password', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ username: 'validuser', password: 'short' });

      expect(res.status).toBe(400);
    });

    test('redirects on successful login', async () => {
      const hashedPass = await bcrypt.hash('password123', 10);
      User.findOne.mockResolvedValue({
        _id: '123',
        username: 'testuser',
        password: hashedPass,
        tier: 'registered',
      });

      const res = await request(app)
        .post('/auth/login')
        .send({ username: 'testuser', password: 'password123' });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/');
    });
  });

  describe('GET /auth/logout', () => {
    test('redirects to login', async () => {
      const res = await request(app).get('/auth/logout');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/login');
    });
  });
});
