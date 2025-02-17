/**
 * @file contextBuilder.js
 * @description Functions to build the context string from transcriptions, respecting token/char limits.
 */

/**
 * Build a context string from an array of transcriptions, truncated based on a max token limit.
 * @param {Array} transcriptions - List of transcription documents (with timestamp & text).
 * @param {number} maxTokens - The approximate maximum number of tokens allowed.
 * @returns {string} - A context string with transcriptions appended until we reach the limit.
 */
function buildContextFromTranscriptions(transcriptions, maxTokens) {
  let context = 'Here are the relevant radio transcriptions:\n\n';
  let currentLength = context.length;

  // Rough estimate: 1 token ≈ 4 characters
  const approxCharLimit = maxTokens * 4;

  for (const t of transcriptions) {
    const date = new Date(t.timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const formattedDate = `${year}-${month}-${day}`;
    const formattedTime = `${hours}:${minutes}:${seconds}`;

    const entry = `[${formattedDate} ${formattedTime}] ${t.text}\n`;

    // Check if adding this entry would exceed our approximate limit
    if ((currentLength + entry.length) > approxCharLimit) {
      break;
    }
    context += entry;
    currentLength += entry.length;
  }

  return context;
}

module.exports = {
  buildContextFromTranscriptions,
};
