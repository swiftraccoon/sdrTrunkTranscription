jest.mock('../../utils/logger', () => require('../mocks/logger'));

// Mock nodemailer before requiring emailService
const mockSendMail = jest.fn();
const mockVerify = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: mockSendMail,
    verify: mockVerify,
  })),
}));

// Need to clear module cache to get fresh instance with mocks
let emailService;
beforeAll(() => {
  // Clear cache for emailService so it picks up the mocked nodemailer
  delete require.cache[require.resolve('../../services/emailService')];
  emailService = require('../../services/emailService');
});

beforeEach(() => {
  mockSendMail.mockReset();
  mockVerify.mockReset();
});

describe('EmailService', () => {
  describe('sendNotification', () => {
    test('sends email with correct options', async () => {
      mockSendMail.mockResolvedValue({ messageId: '123' });

      const result = await emailService.sendNotification('user@example.com', {
        text: 'Fire on Main St',
        timestamp: '2025-01-01T12:00:00Z',
      });

      expect(result).toBe(true);
      expect(mockSendMail).toHaveBeenCalledTimes(1);
      const mailOptions = mockSendMail.mock.calls[0][0];
      expect(mailOptions.to).toBe('user@example.com');
      expect(mailOptions.subject).toBe('New Transcription Match');
      expect(mailOptions.text).toContain('Fire on Main St');
    });

    test('escapes HTML in match text', async () => {
      mockSendMail.mockResolvedValue({ messageId: '456' });

      await emailService.sendNotification('user@example.com', {
        text: '<script>alert("xss")</script>',
        timestamp: '2025-01-01',
      });

      const mailOptions = mockSendMail.mock.calls[0][0];
      expect(mailOptions.html).not.toContain('<script>');
      expect(mailOptions.html).toContain('&lt;script&gt;');
    });

    test('returns false on send failure', async () => {
      mockSendMail.mockRejectedValue(new Error('SMTP error'));

      const result = await emailService.sendNotification('user@example.com', {
        text: 'test',
        timestamp: '2025-01-01',
      });

      expect(result).toBe(false);
    });
  });

  describe('testConnection', () => {
    test('returns true on successful verify', async () => {
      mockVerify.mockResolvedValue(true);
      const result = await emailService.testConnection();
      expect(result).toBe(true);
    });

    test('returns false on verify failure', async () => {
      mockVerify.mockRejectedValue(new Error('Connection refused'));
      const result = await emailService.testConnection();
      expect(result).toBe(false);
    });
  });
});
