const Transcription = require('../models/Transcription');
const logger = require('./logger'); // Ensure logger is implemented and imported correctly

// Function to fetch the latest transcriptions from the database
const fetchLatestTranscriptions = async () => {
  try {
    const transcriptions = await Transcription.find({})
      .sort({ timestamp: -1 })
      .limit(30); // Fetches the most recent 30 transcriptions
    logger.info('Successfully fetched the latest transcriptions.');
    return transcriptions;
  } catch (error) {
    logger.error('Error fetching the latest transcriptions: %s', error.stack);
    throw error; // Rethrow the error after logging
  }
};

module.exports = { fetchLatestTranscriptions };
