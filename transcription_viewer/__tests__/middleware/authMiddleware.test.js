jest.mock('../../utils/logger', () => require('../mocks/logger'));
jest.mock('../../models/User');

const { isAuthenticated, tierAccessControl, isAdmin } = require('../../routes/middleware/authMiddleware');
const User = require('../../models/User');

function mockReq(overrides = {}) {
  return {
    session: {},
    path: '/test',
    method: 'GET',
    ...overrides,
  };
}

function mockRes() {
  const res = {
    locals: {},
    redirect: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    render: jest.fn().mockReturnThis(),
  };
  return res;
}

describe('isAuthenticated', () => {
  test('redirects to /login when no session userId', () => {
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    isAuthenticated(req, res, next);

    expect(res.redirect).toHaveBeenCalledWith('/login');
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next when userId is in session', () => {
    const req = mockReq({ session: { userId: '123' } });
    const res = mockRes();
    const next = jest.fn();

    isAuthenticated(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
  });
});

describe('tierAccessControl', () => {
  test('redirects when no session', async () => {
    const res = mockRes();
    const next = jest.fn();

    // tierAccessControl checks req.session, so we need to handle null/empty
    const req = mockReq({ session: {} });
    await tierAccessControl(req, res, next);

    expect(res.redirect).toHaveBeenCalledWith('/auth/login');
  });

  test('redirects when user not found in DB', async () => {
    User.findById.mockResolvedValue(null);
    const req = mockReq({ session: { userId: 'bad-id' } });
    const res = mockRes();
    const next = jest.fn();

    await tierAccessControl(req, res, next);

    expect(res.redirect).toHaveBeenCalledWith('/auth/login');
  });

  test('sets res.locals and calls next for valid user', async () => {
    const fakeUser = { _id: '123', tier: 'registered', username: 'alice' };
    User.findById.mockResolvedValue(fakeUser);
    const req = mockReq({ session: { userId: '123' } });
    const res = mockRes();
    const next = jest.fn();

    await tierAccessControl(req, res, next);

    expect(res.locals.userTier).toBe('registered');
    expect(res.locals.user).toBe(fakeUser);
    expect(next).toHaveBeenCalled();
  });

  test('returns 500 on database error', async () => {
    User.findById.mockRejectedValue(new Error('DB down'));
    const req = mockReq({ session: { userId: '123' } });
    const res = mockRes();
    const next = jest.fn();

    await tierAccessControl(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('isAdmin', () => {
  test('redirects when no session userId', async () => {
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await isAdmin(req, res, next);

    expect(res.redirect).toHaveBeenCalledWith('/login');
  });

  test('returns 403 for non-admin user', async () => {
    User.findById.mockResolvedValue({ _id: '123', tier: 'registered' });
    const req = mockReq({ session: { userId: '123' } });
    const res = mockRes();
    const next = jest.fn();

    await isAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next for admin user', async () => {
    User.findById.mockResolvedValue({ _id: '123', tier: 'admin' });
    const req = mockReq({ session: { userId: '123' } });
    const res = mockRes();
    const next = jest.fn();

    await isAdmin(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('returns 500 on database error', async () => {
    User.findById.mockRejectedValue(new Error('DB error'));
    const req = mockReq({ session: { userId: '123' } });
    const res = mockRes();
    const next = jest.fn();

    await isAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
