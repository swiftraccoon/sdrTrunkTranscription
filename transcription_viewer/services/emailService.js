const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

class EmailService {
  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.PROTONMAIL_SMTP_HOST || 'smtp.protonmail.ch',
      port: parseInt(process.env.PROTONMAIL_SMTP_PORT, 10) || 587,
      secure: false,
      auth: {
        user: process.env.PROTONMAIL_USERNAME,
        pass: process.env.PROTONMAIL_PASSWORD
      }
    });
  }

  async sendNotification(to, match) {
    try {
      const mailOptions = {
        from: process.env.PROTONMAIL_USERNAME,
        to,
        subject: 'New Transcription Match',
        text: `A new transcription matching your subscription pattern has been detected:\n\n` +
              `Text: ${match.text}\n` +
              `Time: ${match.timestamp}\n\n` +
              `You can view this and other matches on your subscription page.`,
        html: `<h3>New Transcription Match</h3>
               <p>A new transcription matching your subscription pattern has been detected:</p>
               <div style="background: #f5f5f5; padding: 15px; margin: 10px 0; border-radius: 5px;">
                 <p><strong>Text:</strong> ${match.text}</p>
                 <p><strong>Time:</strong> ${match.timestamp}</p>
               </div>
               <p>You can view this and other matches on your subscription page.</p>`
      };

      await this.transporter.sendMail(mailOptions);
      logger.info(`Notification email sent to ${to}`);
      return true;
    } catch (error) {
      logger.error('Error sending notification email:', error);
      return false;
    }
  }

  // Test the email configuration
  async testConnection() {
    try {
      await this.transporter.verify();
      logger.info('Email service connection verified');
      return true;
    } catch (error) {
      logger.error('Email service connection failed:', error);
      return false;
    }
  }
}

module.exports = new EmailService(); 