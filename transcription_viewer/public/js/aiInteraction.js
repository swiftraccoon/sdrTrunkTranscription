/* global document, marked, alert */

/**
 * @file aiInteraction.js
 * @description Client-side logic for the AI Interaction page: model selection, date validation,
 *              sending queries to the server, and rendering the response as Markdown.
 */

// Model configurations for the front-end (used for the dropdown)
const MODEL_CONFIGS = {
  openai: {
    models: [
      { id: 'gpt-4', name: 'GPT-4', contextLength: 8192 },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', contextLength: 128000 },
      { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', contextLength: 16385 },

      // GPT-4o
      { id: 'gpt-4o', name: 'GPT-4o', contextLength: 128000 },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextLength: 128000 },

      // o1 series (commented out 'o1' but left 'o1-mini' and 'o1-preview')
      { id: 'o1-mini', name: 'o1-mini', contextLength: 128000 },
      { id: 'o1-preview', name: 'o1-preview', contextLength: 128000 },

      // Realtime previews
      { id: 'gpt-4o-realtime-preview', name: 'GPT-4o Realtime Preview', contextLength: 128000 },
      { id: 'gpt-4o-mini-realtime-preview', name: 'GPT-4o Mini Realtime Preview', contextLength: 128000 },

      // Audio preview
      { id: 'gpt-4o-audio-preview', name: 'GPT-4o Audio Preview', contextLength: 128000 },
    ],
  },
  google: {
    models: [
      { id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash (Exp)', contextLength: 1056768 },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', contextLength: 1056768 },
      { id: 'gemini-1.5-flash-8b', name: 'Gemini 1.5 Flash-8B', contextLength: 1056768 },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', contextLength: 2105344 },
      { id: 'gemini-1.0-pro', name: 'Gemini 1.0 Pro (Deprecated)', contextLength: 8192 },
      { id: 'text-embedding-004', name: 'Text Embedding 004', contextLength: 2048 },
      { id: 'embedding-001', name: 'Embedding 001', contextLength: 2048 },
      { id: 'aqa', name: 'AQA', contextLength: 8192 },
    ],
  },
};

/**
   * Update the model dropdown based on selected LLM service.
   */
function updateModelOptions() {
  const llmService = document.getElementById('llmService').value;
  const modelSelect = document.getElementById('modelName');
  modelSelect.innerHTML = '';

  MODEL_CONFIGS[llmService].models.forEach((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    option.dataset.context = model.contextLength;
    option.textContent = `${model.name} (${Math.floor(model.contextLength / 1000)}K context)`;
    modelSelect.appendChild(option);
  });
}

/**
   * Format a date string for display
   * @param {string} dateString - ISO date string
   * @returns {string} - Formatted date string
   */
function formatDate(dateString) {
  const date = new Date(dateString);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

/**
   * Set default date range values (last 24 hours)
   */
function setDefaultDateRange() {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  // Format for datetime-local input (YYYY-MM-DDThh:mm)
  const endDateTime = now.toISOString().slice(0, 16);
  const startDateTime = yesterday.toISOString().slice(0, 16);

  document.getElementById('endDate').value = endDateTime;
  document.getElementById('startDate').value = startDateTime;
}

/**
   * Validate the start/end date range. Throws an error if invalid.
   * @returns {Object} - Contains startDate and endDate as ISO strings
   */
async function validateDateRange() {
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;

  if (!startDate || !endDate) {
    throw new Error('Please select both start and end dates/times');
  }

  // Convert to Date objects for comparison
  const startDateTime = new Date(startDate);
  const endDateTime = new Date(endDate);

  if (endDateTime < startDateTime) {
    throw new Error('End date/time must be after start date/time');
  }

  // Return ISO strings for consistency with server expectations
  return {
    startDate: startDateTime.toISOString(),
    endDate: endDateTime.toISOString(),
  };
}

/**
   * Load and display interaction history
   */
async function loadInteractionHistory() {
  const historyDiv = document.getElementById('interactionHistory');
  historyDiv.innerHTML = '<div class="alert alert-info">Loading history...</div>';

  try {
    const response = await fetch('/ai/history');
    if (!response.ok) {
      throw new Error('Failed to fetch history');
    }

    const interactions = await response.json();

    if (interactions.length === 0) {
      historyDiv.innerHTML = '<div class="alert alert-info">No interaction history found.</div>';
      return;
    }

    const historyHTML = interactions.map((interaction) => `
        <div class="card mb-3">
          <div class="card-header">
            <div class="d-flex justify-content-between align-items-center">
              <small class="text-muted">${formatDate(interaction.createdAt)}</small>
              <span class="badge bg-secondary">${interaction.llmService} - ${interaction.modelName}</span>
            </div>
          </div>
          <div class="card-body">
            <h6 class="card-subtitle mb-2 text-muted">Date Range: ${formatDate(interaction.startDate)} to ${formatDate(interaction.endDate)}</h6>
            <p class="card-text"><strong>Transcriptions Analyzed:</strong> ${interaction.transcriptionCount}</p>
            <div class="mb-3">
              <div class="prompt-toggle collapsed" data-bs-toggle="collapse" data-bs-target="#history-response-${interaction._id}">
                <i class="fas fa-chevron-down"></i>
                <strong>Response:</strong>
                <small class="text-muted">(click to expand)</small>
              </div>
              <div class="collapse" id="history-response-${interaction._id}">
                ${marked.parse(interaction.response)}
              </div>
            </div>
          </div>
        </div>
      `).join('');

    historyDiv.innerHTML = historyHTML;

    // Add event listeners for toggle arrows
    document.querySelectorAll('.prompt-toggle').forEach((toggle) => {
      toggle.addEventListener('click', function () {
        this.classList.toggle('collapsed');
      });
    });
  } catch (error) {
    console.error('Error loading history:', error);
    historyDiv.innerHTML = '<div class="alert alert-danger">Failed to load interaction history.</div>';
  }
}

/**
   * Sends the user query to the server, fetches AI response,
   * and displays it using client-side Markdown rendering.
   */
async function sendQuery() {
  const userInput = document.getElementById('userInput').value;
  const responseDiv = document.getElementById('aiResponse');
  const apiKey = document.getElementById('apiKey').value;
  const llmService = document.getElementById('llmService').value;
  const modelName = document.getElementById('modelName').value;
  const tgidsFilter = document.getElementById('tgidsFilter').value;

  if (!apiKey) {
    alert('Please enter your API key');
    return;
  }

  if (userInput.trim() === '') {
    alert('Please enter a query.');
    return;
  }

  responseDiv.innerHTML = '<div class="alert alert-info">Processing your request...</div>';

  try {
    const dateRange = await validateDateRange();

    const response = await fetch('/ai/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: userInput,
        apiKey,
        llmService,
        modelName,
        tgidsFilter: tgidsFilter,
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
      }),
    });

    const data = await response.json();

    if (response.status === 403) {
      responseDiv.innerHTML = '<div class="alert alert-warning">Investor tier required for this feature.</div>';
      return;
    }

    if (!response.ok) {
      throw new Error(data.error || 'Failed to get response');
    }

    // Use Marked to parse AI response as Markdown
    if (data.answer) {
      // "marked" library usage
      const mdHTML = marked.parse(data.answer);

      responseDiv.innerHTML = `
          <div class="card">
            <div class="card-body">
              <h6 class="card-subtitle mb-2 text-muted">AI Response:</h6>
              <div>${mdHTML}</div>
            </div>
          </div>`;
    }
  } catch (error) {
    console.error('Error:', error);
    responseDiv.innerHTML = `<div class="alert alert-danger">${error.message || 'Error processing request. Please try again.'}</div>`;
  }
}

// Add event listener for history tab
document.addEventListener('DOMContentLoaded', () => {
  const historyTab = document.getElementById('history-tab');
  if (historyTab) {
    historyTab.addEventListener('shown.bs.tab', loadInteractionHistory);
  }

  // Set default date range
  setDefaultDateRange();
});
