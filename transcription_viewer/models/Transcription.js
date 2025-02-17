const mongoose = require('mongoose');

const transcriptionSchema = new mongoose.Schema({
  text: { type: String, required: true },
  mp3FilePath: { type: String, required: true },
  timestamp: { type: Date, required: true },
  talkgroupId: { type: String, required: true },
  radioId: { type: String, required: true },
});

// Add a unique compound index so that any combination of
// (talkgroupId, radioId, timestamp) cannot appear more than once
transcriptionSchema.index(
  { talkgroupId: 1, radioId: 1, timestamp: 1 },
  { unique: true },
);
// Create a text index on the text field for efficient search
transcriptionSchema.index({ text: 'text' });

transcriptionSchema.pre('save', function (next) {
  if (!this.mp3FilePath) {
    console.error('Error saving transcription: MP3 file path required.');
    next(new Error('MP3 file path required.'));
  } else {
    if (this.text === '') {
      this.text = 'unable_to_transcribe_audio';
    }
    console.log('Saving new transcription for talkgroup ID:', this.talkgroupId);
    // Adjust the mp3FilePath to store only the web-accessible relative path
    const relativePathIndex = this.mp3FilePath.indexOf('uploads/');
    if (relativePathIndex !== -1) {
      // Extract the relative web-accessible path starting from 'uploads/'
      this.mp3FilePath = this.mp3FilePath.substring(relativePathIndex);
      console.log('mp3FilePath adjusted to web-accessible path:', this.mp3FilePath);
    } else {
      console.error('Error: mp3FilePath does not include "uploads/". File may not be web accessible.');
      next(new Error('mp3FilePath must include "uploads/" to be web accessible.'));
    }
    next();
  }
});

transcriptionSchema.post('save', (doc) => {
  console.log(`Transcription successfully saved for talkgroup ID: ${doc.talkgroupId} at timestamp: ${doc.timestamp}`);
});

transcriptionSchema.post('save', (error, doc, next) => {
  if (error.name === 'MongoError' && error.code === 11000) {
    console.error('Error saving transcription: Duplicate key error.', error.message);
    console.error(error.stack);
    next(new Error('Duplicate key error: A transcription with the same parameters already exists.'));
  } else if (error) {
    console.error('Error saving transcription:', error.message);
    console.error(error.stack);
    next(error);
  } else {
    next();
  }
});

/**
 * Filters out transcriptions matching specific patterns.
 * @param {Array} transcriptions - Array of transcription objects to filter.
 * @returns {Array} Filtered array of transcription objects.
 */
transcriptionSchema.statics.filterTranscriptions = function (transcriptions) {
  // Patterns to exclude if they match the entire text
  const patterns = [
    // 1. "Thank you" plus optional punctuation (case-insensitive)
    /^thank you[!.]?$/i,

    // 2. Strings of one or more "BANG" or "BANG!" only (case-insensitive)
    //    e.g. "BANG", "BANG BANG", "BANG! BANG!", etc.
    /^(?:BANG!?)(?:\s+(?:BANG!?))*$/i,

    // 3. "AH" followed by one or more "H" (case-insensitive)
    //    e.g. "AH", "AHH", "AHHHHHH", etc.
    /^ah+$/i,

    // 4. Only periods and spaces
    //    e.g. ".", "..", "...", ". .", ". . .", etc.
    /^[.\s]+$/,
  ];

  return transcriptions.filter((transcription) =>
    // Exclude transcriptions if they match any pattern above
    !patterns.some((pattern) => pattern.test(transcription.text)));
};

const Transcription = mongoose.model('Transcription', transcriptionSchema);

// Ensure the text index is created on startup
Transcription.init().then(() => console.log('Text index for Transcription created')).catch((err) => {
  console.error('Error creating text index for Transcription:', err.message);
  console.error(err.stack);
});

module.exports = Transcription;
