import logger from './clientLogger.js';

class TranscriptionManager {
  constructor() {
    this.ws = null;
    this.reconnectionAttempts = 0;
    // Get autoplay preference from localStorage (device-specific)
    this.autoplayEnabled = localStorage.getItem('autoplayEnabled') === 'true';
    this.audioQueue = [];
    this.currentlyPlaying = '';
    this.lastPlayedAudio = '';
    this.playedAudioHistory = new Set(); // Track all played audio to prevent loops
    this.maxReconnectionAttempts = 6;
    this.initialized = false;
    this.audioElement = null; // Reusable audio element
    this.userInteracted = false; // Track if user has interacted (for iOS)

    // Classes used for theming
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

    this.setupAudioElement();
    this.setupEventListeners();
    this.applyStoredTheme();
    this.setupWebSocket();
    
    // Set initial autoplay state in UI
    const toggleEl = document.getElementById('autoplayToggle');
    if (toggleEl) {
      toggleEl.checked = this.autoplayEnabled;
    }
  }

  setupAudioElement() {
    // Create a reusable audio element for better control
    this.audioElement = new Audio();
    this.audioElement.preload = 'auto';
    
    // Handle audio ended event
    this.audioElement.addEventListener('ended', () => {
      logger.debug('Audio playback completed', { path: this.currentlyPlaying });
      // Add to history to prevent replaying
      if (this.currentlyPlaying) {
        this.playedAudioHistory.add(this.currentlyPlaying);
        this.lastPlayedAudio = this.currentlyPlaying;
      }
      this.currentlyPlaying = '';

      if (this.autoplayEnabled) {
        if (this.audioQueue.length > 0) {
          // More items in queue—play next
          this.playNextAudio();
        }
        // Don't request more from server - let server push new audio as it arrives
      }
    });
    
    // Handle audio errors
    this.audioElement.addEventListener('error', (e) => {
      logger.error('Audio playback error', { error: e, path: this.currentlyPlaying });
      this.currentlyPlaying = '';
      // Try next audio if available
      if (this.autoplayEnabled && this.audioQueue.length > 0) {
        this.playNextAudio();
      }
    });
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
      // Always send autoplay status on connection with device ID
      setTimeout(() => {
        this.sendAutoplayStatus();
      }, 100); // Small delay to ensure connection is ready
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        logger.debug('WebSocket message received', { action: data.action });
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
      case 'requestAutoplayStatus':
        // Server is asking for our device-specific autoplay preference
        this.sendAutoplayStatus();
        break;
        
      case 'autoplayStatus':
      case 'autoplayStatusUpdated':
      case 'autoplayStatusConfirmed':
        // Server acknowledged our autoplay status
        logger.info('Autoplay status confirmed by server', { status: data.autoplay });
        // If we have items in the queue and autoplay is enabled, start playing
        if (this.autoplayEnabled && this.audioQueue.length > 0 && !this.currentlyPlaying) {
          this.playNextAudio();
        }
        break;

      case 'nextAudio':
      case 'audioAvailable':  // Handle both message types
        if (!this.autoplayEnabled) {
          logger.debug('Ignoring audio, autoplay disabled', { 
            autoplayEnabled: this.autoplayEnabled,
            action: data.action 
          });
          return;
        }
        if (!this.shouldPlayAudio(data)) {
          logger.debug('Skipping audio, does not match current filters', {
            talkgroupId: data.talkgroupId,
          });
          return;
        }
        
        // Check if we've already played this audio
        if (this.playedAudioHistory.has(data.path)) {
          logger.debug('Audio already played before', { path: data.path });
          return;
        }
        
        logger.info('Received audio message', { 
          action: data.action,
          path: data.path 
        });
        this.queueAudio(data.path);
        break;

      case 'newTranscription':
        this.handleNewTranscription(data.data);
        break;

      case 'noMoreAudio':
        logger.info('Server indicates no more audio in the queue');
        break;

      default:
        logger.warn('Unknown WebSocket message type', { action: data.action });
    }
  }

  updateAutoplayStatus(status) {
    this.autoplayEnabled = status;
    // Store in localStorage for device-specific preference
    localStorage.setItem('autoplayEnabled', status.toString());
    const toggleEl = document.getElementById('autoplayToggle');
    if (toggleEl) {
      toggleEl.checked = status;
    }
    logger.info('Autoplay status updated', { enabled: status });
  }

  /**
   * Decide if we should play this talkgroup based on the user's current filter.
   */
  shouldPlayAudio(data) {
    // If the server didn't include talkgroupId, do NOT play it
    if (!data.talkgroupId) return false;

    const bodyEl = document.querySelector('body');
    const currentPage = bodyEl?.dataset?.page;
    const selectedGroup = bodyEl?.dataset?.selectedGroup;

    // If user selected "All" or is not on index, there's no special filter
    if (currentPage !== 'index' || selectedGroup === 'All') {
      return true;
    }

    // Otherwise, ensure talkgroup is in the user's chosen group
    return this.transcriptionMatchesGroup(data.talkgroupId, selectedGroup);
  }

  transcriptionMatchesGroup(tgId, groupName) {
    const tgNum = Number(tgId);
    if (Number.isNaN(tgNum)) return false;

    // The server provides groupMappings in the global window object
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

  queueAudio(path) {
    // Avoid duplicates - check if already played, playing, or queued
    if (
      this.currentlyPlaying === path ||
      this.audioQueue.includes(path) ||
      this.playedAudioHistory.has(path)
    ) {
      logger.debug('Audio already queued or played before', { path });
      return;
    }

    this.audioQueue.push(path);
    logger.info('Audio added to queue', { path, queueLength: this.audioQueue.length });

    // If nothing is currently playing, start
    if (!this.currentlyPlaying) {
      this.playNextAudio();
    }
  }

  async playNextAudio() {
    const path = this.audioQueue.shift();
    if (!path) return;

    // Double-check we haven't played this already
    if (this.playedAudioHistory.has(path)) {
      logger.debug('Skipping already played audio', { path });
      // Try next in queue
      if (this.audioQueue.length > 0) {
        this.playNextAudio();
      }
      return;
    }

    this.currentlyPlaying = path;
    logger.info('Starting audio playback', { path });

    try {
      // Use the reusable audio element
      this.audioElement.src = path;
      
      // For iOS Safari, we need user interaction first
      // Try to play with user interaction fallback
      const playPromise = this.audioElement.play();
      
      if (playPromise !== undefined) {
        playPromise.then(() => {
          // Successfully playing
          this.userInteracted = true;
          logger.debug('Audio playing successfully', { path });
        }).catch(error => {
          if (error.name === 'NotAllowedError') {
            // Browser blocked autoplay, show notification to user
            logger.warn('Autoplay blocked by browser', { error: error.message });
            this.showAutoplayBlockedNotification();
            this.currentlyPlaying = '';
            
            // Keep the audio in queue for retry after user interaction
            this.audioQueue.unshift(path);
          } else {
            logger.error('Audio playback failed', { error, path });
            this.currentlyPlaying = '';
            // Mark as played so we don't retry this file
            this.playedAudioHistory.add(path);
            
            // Try next audio if available
            if (this.autoplayEnabled && this.audioQueue.length > 0) {
              setTimeout(() => this.playNextAudio(), 500);
            }
          }
        });
      }
    } catch (error) {
      logger.error('Audio playback failed', { error, path });
      this.currentlyPlaying = '';
      // Mark as played so we don't retry
      this.playedAudioHistory.add(path);
    }
  }
  
  showAutoplayBlockedNotification() {
    // Create or update notification
    let notification = document.getElementById('autoplay-blocked-notification');
    if (!notification) {
      notification = document.createElement('div');
      notification.id = 'autoplay-blocked-notification';
      notification.className = 'alert alert-warning alert-dismissible fade show position-fixed top-0 start-50 translate-middle-x mt-3';
      notification.style.zIndex = '9999';
      notification.innerHTML = `
        <strong>Autoplay Blocked</strong><br>
        ${/iPhone|iPad|iPod/.test(navigator.userAgent) ? 'Tap' : 'Click'} anywhere on the page to enable audio playback.
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
      `;
      document.body.appendChild(notification);
      
      // Remove notification after 5 seconds
      setTimeout(() => {
        notification?.remove();
      }, 5000);
    }
    
    // Add both click and touchstart handlers for mobile
    const enableAudio = () => {
      if (this.autoplayEnabled && this.audioQueue.length > 0) {
        logger.info('User interaction detected, attempting to play queued audio');
        // Try to play the next audio in queue
        this.playNextAudio();
      }
    };
    
    // For mobile devices (especially iOS)
    document.addEventListener('touchstart', enableAudio, { once: true });
    // For desktop
    document.addEventListener('click', enableAudio, { once: true });
  }

  handleNewTranscription(transcriptionData) {
    const bodyEl = document.querySelector('body');
    const currentPage = bodyEl?.dataset?.page || 'unknown';
    const selectedGroup = bodyEl?.dataset?.selectedGroup || 'All';

    if (currentPage === 'searchResults') {
      logger.debug('Ignoring transcription on search results page');
      return;
    }

    // If user has selected a group, skip transcriptions from other talkgroups
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

  setupEventListeners() {
    logger.info('Setting up event listeners');
    this.setupThemeListeners();
    this.setupTranscriptionListeners();
    this.setupAutoplayToggle();
  }

  /************************************************
   *                THEME METHODS
   ************************************************/

  /**
   * Called once on DOMContentLoaded. We read the URL hash or localStorage
   * to figure out which theme to apply on page load.
   */
  applyStoredTheme() {
    try {
      logger.info('Applying stored theme');

      // If there's a theme in the URL hash, use that first
      const themeFromHash = window.location.hash.slice(1);
      if (themeFromHash && this.themeClasses.includes(themeFromHash)) {
        logger.info('Using theme from URL hash', { theme: themeFromHash });
        this.applyTheme(themeFromHash);
        return;
      }

      // Otherwise, read localStorage
      const theme = localStorage.getItem('theme');
      if (theme && this.themeClasses.includes(theme)) {
        logger.info('Using theme from localStorage', { theme });
        this.applyTheme(theme);
      } else {
        logger.info('No stored theme found, using default "light"');
        this.applyTheme('light');
      }
    } catch (error) {
      logger.error('Failed to restore theme from storage', error);
      this.applyTheme('light');
    }
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

      // Mark the correct dropdown item active
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

      // Mark the correct inline theme button active
      const themeButtons = document.querySelectorAll('[data-theme]:not(.dropdown-item)');
      themeButtons.forEach(button => {
        const buttonTheme = button.getAttribute('data-theme');
        button.classList.toggle('active', buttonTheme === theme);
      });

      // Update the URL hash
      const newUrl = window.location.href.split('#')[0] + '#' + theme;
      window.history.replaceState(null, '', newUrl);

      // Dispatch an event so other scripts can react to theme changes
      window.dispatchEvent(new CustomEvent('themeChanged', { detail: { theme } }));

      logger.info('Theme applied successfully', {
        theme,
        newClasses: document.body.className
      });
    } catch (error) {
      logger.error('Failed to apply theme', error, { theme });
    }
  }

  setupThemeListeners() {
    logger.info('Setting up theme listeners');

    const themeDropdown = document.getElementById('themeDropdown');
    if (themeDropdown) {
      // .dropdown-toggle is the button; the actual items are in the sibling .dropdown-menu
      const dropdownMenu = themeDropdown.nextElementSibling;
      if (dropdownMenu) {
        const dropdownItems = dropdownMenu.querySelectorAll('.dropdown-item[data-theme]');
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
      }
    } else {
      logger.warn('Theme dropdown not found');
    }

    // Also handle any direct theme buttons in the UI
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

    // If user manually changes the URL hash, apply that theme
    window.addEventListener('hashchange', () => {
      const themeFromHash = window.location.hash.slice(1);
      logger.info('URL hash changed', { themeFromHash });
      if (themeFromHash && this.themeClasses.includes(themeFromHash)) {
        this.applyTheme(themeFromHash);
      }
    });
  }

  /************************************************
   *          TRANSCRIPTION CLICK HANDLING
   ************************************************/

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

  /************************************************
   *             AUTOPLAY TOGGLE
   ************************************************/

  setupAutoplayToggle() {
    const toggleEl = document.getElementById('autoplayToggle');
    if (toggleEl) {
      toggleEl.addEventListener('change', () => {
        this.autoplayEnabled = toggleEl.checked;
        // Save to localStorage for device-specific preference
        localStorage.setItem('autoplayEnabled', this.autoplayEnabled.toString());
        logger.info('Autoplay toggled by user', { enabled: this.autoplayEnabled });
        
        // Send to server for WebSocket coordination (optional)
        this.sendAutoplayStatus();
        
        // If enabling autoplay and we have audio ready, start playing
        if (this.autoplayEnabled && this.audioQueue.length > 0) {
          this.playNextAudio();
        }
      });
    }
  }

  sendAutoplayStatus() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      // Send device-specific autoplay status
      const deviceId = this.getDeviceId();
      this.ws.send(JSON.stringify({
        action: 'autoplayStatus',
        autoplay: this.autoplayEnabled,
        deviceId: deviceId
      }));
      logger.info('Sent autoplay status', { enabled: this.autoplayEnabled, deviceId });
    }
  }
  
  getDeviceId() {
    // Get or create a unique device ID stored in localStorage
    let deviceId = localStorage.getItem('deviceId');
    if (!deviceId) {
      deviceId = 'device_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
      localStorage.setItem('deviceId', deviceId);
    }
    return deviceId;
  }

  /************************************************
   *            WEBSOCKET RECONNECT
   ************************************************/

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

// Create and initialize the global manager
let manager;
document.addEventListener('DOMContentLoaded', () => {
  logger.info('DOM loaded, initializing TranscriptionManager');
  manager = new TranscriptionManager();
  manager.init();
  // Expose it if needed for debugging
  window.manager = manager;
});
