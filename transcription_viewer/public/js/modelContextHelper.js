/**
 * @file modelContextHelper.js
 * @description Defines a helper function to retrieve approximate context length (token limit)
 *              for various OpenAI and Google (Gemini) models.
 */

/**
 * Returns the approximate max token context length for a given service and model.
 * @param {string} service - 'openai' or 'google'
 * @param {string} model - Name/ID of the model (e.g. 'gpt-4', 'gemini-1.5-flash')
 * @returns {number} - The approximate max token context length
 */
function getModelContextLength(service, model) {
  const contextLengths = {
    openai: {
      // Older GPT-4
      'gpt-4': 8192, // 8,192 tokens
      // GPT-4 Turbo
      'gpt-4-turbo': 128000, // 128,000 tokens
      // GPT-3.5 Turbo (latest)
      'gpt-3.5-turbo': 16385, // 16,385 tokens

      // New GPT-4o models
      'gpt-4o': 128000,
      'gpt-4o-mini': 128000,

      // o1 series (reasoning)
      o1: 200000,
      'o1-mini': 128000,
      'o1-preview': 128000,

      // Realtime preview
      'gpt-4o-realtime-preview': 128000,
      'gpt-4o-mini-realtime-preview': 128000,

      // Audio preview
      'gpt-4o-audio-preview': 128000,
    },
    google: {
      // Gemini 2.0 Flash Experimental
      'gemini-2.0-flash-exp': 1056768,

      // Gemini 1.5 Flash
      'gemini-1.5-flash': 1056768,

      // Gemini 1.5 Flash-8B
      'gemini-1.5-flash-8b': 1056768,

      // Gemini 1.5 Pro
      'gemini-1.5-pro': 2105344,

      // Gemini 1.0 Pro (deprecated Feb. 15, 2025)
      'gemini-1.0-pro': 8192,

      // Embeddings
      'text-embedding-004': 2048,
      'embedding-001': 2048,

      // AQA
      aqa: 8192,
    },
  };

  // Default to 4096 tokens if model is not listed
  return contextLengths[service]?.[model] ?? 4096;
}

module.exports = {
  getModelContextLength,
};
