/**
 * @file llmClient.js
 * @description Contains functions to initialize the LLM client (OpenAI/Google) and generate responses.
 */

const { OpenAI } = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

/**
 * Initialize LLM client based on the chosen service.
 * @param {string} service - 'openai' or 'google'
 * @param {string} apiKey - API key for the chosen service
 * @returns {Object} - Instantiated LLM client
 */
function initializeLLMClient(service, apiKey) {
  switch (service) {
  case 'openai':
    return new OpenAI({ apiKey });
  case 'google':
    return new GoogleGenerativeAI(apiKey);
  default:
    throw new Error('Unsupported LLM service');
  }
}

/**
 * Generate a response from the specified LLM service and model.
 * @param {string} service - 'openai' or 'google'
 * @param {Object} client - Instantiated client object (OpenAI or GoogleGenerativeAI)
 * @param {string} model - Model name (e.g. 'gpt-4', 'gemini-1.5-flash', etc.)
 * @param {string} prompt - Text prompt to send to the model
 * @returns {Promise<string>} - The text content of the model's response
 */
async function generateLLMResponse(service, client, model, prompt) {
  switch (service) {
  case 'openai':
    // For OpenAI:
    const completion = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
    });
    return completion.choices[0].message.content;

  case 'google':
    // For Google Gemini:
    const geminiModel = client.getGenerativeModel({ model });
    const result = await geminiModel.generateContent(prompt);
    return result.response.text();

  default:
    throw new Error('Unsupported LLM service');
  }
}

module.exports = {
  initializeLLMClient,
  generateLLMResponse,
};
