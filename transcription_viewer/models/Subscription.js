const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  pattern: {
    type: String,
    required: true
  },
  isRegex: {
    type: Boolean,
    default: false
  },
  emailNotification: {
    type: Boolean,
    default: false
  },
  email: {
    type: String,
    required: function() { return this.emailNotification; }
  },
  keepHistory: {
    type: Boolean,
    default: true
  },
  matches: [{
    transcriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transcription'
    },
    timestamp: {
      type: Date,
      default: Date.now
    },
    text: String
  }],
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastNotified: {
    type: Date
  }
});

// Keep only the last 15 matches if keepHistory is true
subscriptionSchema.pre('save', function(next) {
  if (this.keepHistory && this.matches.length > 15) {
    this.matches = this.matches.slice(-15);
  }
  next();
});

const Subscription = mongoose.model('Subscription', subscriptionSchema);

module.exports = Subscription; 