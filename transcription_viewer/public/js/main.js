/* global document, window, WebSocket, Audio, localStorage */
import logger from './clientLogger.js';

class TranscriptionManager {
  constructor() {
    this.ws = null;
    this.reconnectionAttempts = 0;
    this.autoplayEnabled = false;
    this.audioQueue = [];
    this.currentlyPlaying = '';
    this.lastPlayedAudio = '';
    this.maxReconnectionAttempts = 6;
    this.initialized = false;
    this.themeClasses = [
      'light',
      'dark',
      'ultraDark',
      'colorPsychology',
      'vibrantSunrise',
      'sereneOcean',
      'intelligenceAgency'
    ];
  }

  init() {
    if (this.initialized) return;
    this.initialized = true;
    logger.info('Initializing TranscriptionManager');

    this.setupEventListeners();
    this.applyStoredTheme();
    this.setupWebSocket();
  }

  setupWebSocket() {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      logger.debug('WebSocket already active, skipping connection');
      return;
    }

    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.ws = new WebSocket(`${protocol}//${window.location.host}`);
      this.setupWebSocketHandlers();
      logger.info('Attempting WebSocket connection', { protocol });
    } catch (error) {
      logger.error('Failed to create WebSocket connection', error);
      this.attemptReconnect();
    }
  }

  setupWebSocketHandlers() {
    this.ws.onopen = () => {
      logger.info('WebSocket connection established');
      this.reconnectionAttempts = 0;
      this.sendAutoplayStatus();
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        logger.debug('WebSocket message received', { type: data.action });
        this.handleWebSocketMessage(data);
      } catch (error) {
        logger.error('Failed to process WebSocket message', error);
      }
    };

    this.ws.onerror = (error) => {
      logger.error('WebSocket error occurred', error);
      this.attemptReconnect();
    };

    this.ws.onclose = () => {
      logger.info('WebSocket connection closed');
      this.ws = null;
      this.attemptReconnect();
    };
  }

  handleWebSocketMessage(data) {
    switch (data.action) {
      case 'autoplayStatus':
      case 'autoplayStatusUpdated':
        this.updateAutoplayStatus(data.autoplay);
        break;

      case 'nextAudio':
        this.handleNextAudio(data);
        break;

      case 'newTranscription':
        this.handleNewTranscription(data.data);
        break;

      default:
        logger.warn('Unknown WebSocket message type', { action: data.action });
    }
  }

  updateAutoplayStatus(status) {
    this.autoplayEnabled = status;
    const toggleEl = document.getElementById('autoplayToggle');
    if (toggleEl) {
      toggleEl.checked = status;
    }
    logger.info('Autoplay status updated', { enabled: status });
  }

  handleNextAudio(data) {
    if (!this.autoplayEnabled) {
      logger.debug('Ignoring nextAudio, autoplay disabled');
      return;
    }

    if (!this.shouldPlayAudio(data)) {
      logger.debug('Skipping audio, does not match current filters', {
        talkgroupId: data.talkgroupId,
      });
      return;
    }

    this.queueAudio(data.path);
  }

  shouldPlayAudio(data) {
    if (!data.talkgroupId) return true;

    const bodyEl = document.querySelector('body');
    const currentPage = bodyEl?.dataset?.page;
    const selectedGroup = bodyEl?.dataset?.selectedGroup;

    return !(
      currentPage === 'index' &&
      selectedGroup !== 'All' &&
      !this.transcriptionMatchesGroup(data.talkgroupId, selectedGroup)
    );
  }

  queueAudio(path) {
    if (
      this.currentlyPlaying === path ||
      this.audioQueue.includes(path) ||
      this.lastPlayedAudio === path
    ) {
      logger.debug('Audio already queued or recently played', { path });
      return;
    }

    this.audioQueue.push(path);
    logger.info('Audio added to queue', { path, queueLength: this.audioQueue.length });

    if (!this.currentlyPlaying) {
      this.playNextAudio();
    }
  }

  async playNextAudio() {
    const path = this.audioQueue.shift();
    if (!path) return;

    this.currentlyPlaying = path;
    logger.info('Starting audio playback', { path });

    try {
      const audio = new Audio(path);
      await audio.play();

      audio.onended = () => {
        logger.debug('Audio playback completed', { path });
        this.lastPlayedAudio = path;
        this.currentlyPlaying = '';

        if (this.autoplayEnabled) {
          if (this.audioQueue.length > 0) {
            this.playNextAudio();
          } else if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ action: 'requestNextAudio' }));
          }
        }
      };
    } catch (error) {
      logger.error('Audio playback failed', error, { path });
      this.currentlyPlaying = '';
    }
  }

  handleNewTranscription(transcriptionData) {
    const bodyEl = document.querySelector('body');
    const currentPage = bodyEl?.dataset?.page || 'unknown';
    const selectedGroup = bodyEl?.dataset?.selectedGroup || 'All';

    if (currentPage === 'searchResults') {
      logger.debug('Ignoring transcription on search results page');
      return;
    }

    if (
      currentPage === 'index' &&
      selectedGroup !== 'All' &&
      !this.transcriptionMatchesGroup(transcriptionData.talkgroupId, selectedGroup)
    ) {
      logger.debug('Ignoring transcription, group mismatch', {
        talkgroup: transcriptionData.talkgroupId,
        selectedGroup,
      });
      return;
    }

    this.displayTranscription(transcriptionData);
  }

  displayTranscription(data) {
    const transcriptionsDiv = document.getElementById('transcriptions');
    if (!transcriptionsDiv) {
      logger.error('Transcriptions container not found');
      return;
    }

    const transcriptionDiv = document.createElement('div');
    transcriptionDiv.classList.add('transcription', 'slideIn');

    const timestamp = this.formatTimestamp(data.timestamp);
    transcriptionDiv.innerHTML = `
      <span class="transcription-meta">
        ${timestamp} | ${data.radioId} to ${data.talkgroupName}
      </span>
      <button class="play-button" data-mp3="${data.mp3FilePath}">&#9658;</button>
      <br />
      <span class="transcription-text">${data.text}</span>
    `;

    transcriptionsDiv.insertBefore(transcriptionDiv, transcriptionsDiv.firstChild);
    requestAnimationFrame(() => transcriptionDiv.classList.remove('slideIn'));
  }

  formatTimestamp(isoString) {
    const date = new Date(isoString);
    const yyyy = date.getFullYear();
    const mm   = String(date.getMonth() + 1).padStart(2, '0');
    const dd   = String(date.getDate()).padStart(2, '0');
    const hh   = String(date.getHours()).padStart(2, '0');
    const min  = String(date.getMinutes()).padStart(2, '0');
    const ss   = String(date.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
  }

  transcriptionMatchesGroup(tgId, groupName) {
    const tgNum = Number(tgId);
    if (Number.isNaN(tgNum)) return false;

    const segments = window.groupMapping[groupName];
    if (!segments) return false;

    const ranges = segments.split(',').map(range => {
      const parts = range.trim().split('-');
      if (parts.length === 1) {
        const num = parseInt(parts[0], 10);
        return { type: 'single', value: num };
      }
      const start = parseInt(parts[0], 10);
      const end = parseInt(parts[1], 10);
      return { type: 'range', start, end };
    });

    return ranges.some(range =>
      (range.type === 'single' && range.value === tgNum) ||
      (range.type === 'range' && tgNum >= range.start && tgNum <= range.end)
    );
  }

  setupEventListeners() {
    logger.info('Setting up event listeners');
    this.setupThemeListeners();
    this.setupTranscriptionListeners();
    this.setupAutoplayToggle();
  }

  setupThemeListeners() {
    logger.info('Setting up theme listeners');

    const themeDropdown = document.getElementById('themeDropdown');
    if (themeDropdown) {
      const dropdownItems = themeDropdown.nextElementSibling.querySelectorAll('.dropdown-item[data-theme]');
      logger.info(`Found ${dropdownItems.length} theme dropdown items`);

      dropdownItems.forEach(item => {
        item.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();

          const theme = item.getAttribute('data-theme');
          logger.info('Theme dropdown item clicked', { theme });
          if (theme) {
            this.applyTheme(theme);
          }
        });
      });
    } else {
      logger.warn('Theme dropdown not found');
    }

    const themeButtons = document.querySelectorAll('[data-theme]:not(.dropdown-item)');
    logger.info(`Found ${themeButtons.length} direct theme buttons`);

    themeButtons.forEach(button => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        const theme = button.getAttribute('data-theme');
        logger.info('Theme button clicked', { theme });
        if (theme) {
          this.applyTheme(theme);
        }
      });
    });

    window.addEventListener('hashchange', () => {
      const themeFromHash = window.location.hash.slice(1);
      logger.info('URL hash changed', { themeFromHash });
      if (themeFromHash && this.themeClasses.includes(themeFromHash)) {
        this.applyTheme(themeFromHash);
      }
    });
  }

  applyTheme(theme) {
    if (!theme || !this.themeClasses.includes(theme)) {
      logger.warn('Attempted to apply invalid theme', { theme });
      return;
    }

    try {
      logger.info('Applying theme', { theme, currentClasses: document.body.className });
      document.body.classList.remove(...this.themeClasses);
      document.body.classList.add(theme);
      localStorage.setItem('theme', theme);

      const dropdownItems = document.querySelectorAll('.dropdown-item[data-theme]');
      dropdownItems.forEach(item => {
        const itemTheme = item.getAttribute('data-theme');
        if (itemTheme === theme) {
          item.classList.add('active');
          const dropdownButton = document.getElementById('themeDropdown');
          if (dropdownButton) {
            dropdownButton.textContent = item.textContent;
          }
        } else {
          item.classList.remove('active');
        }
      });

      const themeButtons = document.querySelectorAll('[data-theme]:not(.dropdown-item)');
      themeButtons.forEach(button => {
        const buttonTheme = button.getAttribute('data-theme');
        button.classList.toggle('active', buttonTheme === theme);
      });

      const newUrl = window.location.href.split('#')[0] + '#' + theme;
      window.history.replaceState(null, '', newUrl);

      window.dispatchEvent(new CustomEvent('themeChanged', { detail: { theme } }));

      logger.info('Theme applied successfully', {
        theme,
        newClasses: document.body.className,
        activeDropdownItems: document.querySelectorAll('.dropdown-item[data-theme].active').length,
        activeButtons: document.querySelectorAll('[data-theme]:not(.dropdown-item).active').length
      });
    } catch (error) {
      logger.error('Failed to apply theme', error, { theme });
    }
  }

  applyStoredTheme() {
    try {
      logger.info('Applying stored theme');

      const themeFromHash = window.location.hash.slice(1);
      if (themeFromHash && this.themeClasses.includes(themeFromHash)) {
        logger.info('Using theme from URL hash', { theme: themeFromHash });
        this.applyTheme(themeFromHash);
        return;
      }

      const theme = localStorage.getItem('theme');
      if (theme && this.themeClasses.includes(theme)) {
        logger.info('Using theme from localStorage', { theme });
        this.applyTheme(theme);
      } else {
        logger.info('No stored theme found, using default light theme');
        this.applyTheme('light');
      }
    } catch (error) {
      logger.error('Failed to restore theme from storage', error);
      this.applyTheme('light');
    }
  }

  setupTranscriptionListeners() {
    const transcriptionsEl = document.getElementById('transcriptions');
    if (transcriptionsEl) {
      transcriptionsEl.addEventListener('click', this.handleTranscriptionClick.bind(this));
    }
  }

  async handleTranscriptionClick(event) {
    if (!event.target.classList.contains('play-button')) return;

    const audioPath = event.target.dataset.mp3;
    logger.info('Play button clicked', { audioPath });

    try {
      const audio = new Audio(audioPath);
      await audio.play();
    } catch (error) {
      logger.error('Failed to play audio from click', error, { audioPath });
    }
  }

  setupAutoplayToggle() {
    const toggleEl = document.getElementById('autoplayToggle');
    if (toggleEl) {
      toggleEl.addEventListener('change', () => {
        this.autoplayEnabled = toggleEl.checked;
        this.sendAutoplayStatus();
      });
    }
  }

  sendAutoplayStatus() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        action: 'setAutoplayStatus',
        autoplay: this.autoplayEnabled,
      }));
      logger.info('Sent autoplay status', { enabled: this.autoplayEnabled });
    }
  }

  attemptReconnect() {
    if (this.reconnectionAttempts >= this.maxReconnectionAttempts) {
      logger.warn('Maximum reconnection attempts reached');
      return;
    }

    const delay = Math.min(2 ** this.reconnectionAttempts * 1000, 60000);
    logger.info('Scheduling reconnection attempt', {
      attempt: this.reconnectionAttempts + 1,
      delayMs: delay,
    });

    this.reconnectionAttempts++;
    setTimeout(() => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        this.setupWebSocket();
      }
    }, delay);
  }
}

let manager;
document.addEventListener('DOMContentLoaded', () => {
  logger.info('DOM loaded, initializing TranscriptionManager');
  manager = new TranscriptionManager();
  manager.init();
  window.manager = manager;
});
