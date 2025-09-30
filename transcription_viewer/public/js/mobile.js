/**
 * Mobile Enhancements for Transcription Viewer
 * Adds touch gestures, PWA features, and mobile optimizations
 */

class MobileEnhancements {
  constructor() {
    this.touchStartX = 0;
    this.touchStartY = 0;
    this.pullDistance = 0;
    this.isRefreshing = false;
    this.audioPlayer = null;
    this.currentlyPlaying = null;
    
    this.init();
  }

  init() {
    // Only initialize on mobile devices
    if (!this.isMobile()) return;
    
    this.setupTouchGestures();
    this.setupPullToRefresh();
    this.setupMobileAudioPlayer();
    this.setupOfflineDetection();
    this.setupVibrationFeedback();
    this.optimizeScrolling();
    this.setupOrientationHandler();
    this.setupPWA();
  }

  isMobile() {
    return window.matchMedia('(max-width: 768px)').matches || 
           'ontouchstart' in window ||
           navigator.maxTouchPoints > 0;
  }

  /**
   * Setup swipe gestures for transcription cards
   */
  setupTouchGestures() {
    const transcriptions = document.querySelectorAll('.transcription');
    
    transcriptions.forEach(card => {
      let startX = 0;
      let currentX = 0;
      let cardElement = card;
      
      // Touch start
      card.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        cardElement.style.transition = 'none';
      }, { passive: true });
      
      // Touch move
      card.addEventListener('touchmove', (e) => {
        currentX = e.touches[0].clientX;
        const diffX = currentX - startX;
        
        // Only allow left swipe
        if (diffX < 0 && Math.abs(diffX) < 100) {
          cardElement.style.transform = `translateX(${diffX}px)`;
        }
      }, { passive: true });
      
      // Touch end
      card.addEventListener('touchend', (e) => {
        const diffX = currentX - startX;
        cardElement.style.transition = 'transform 0.3s ease';
        
        // If swiped more than 50px, show actions
        if (Math.abs(diffX) > 50 && diffX < 0) {
          cardElement.classList.add('swiped');
          cardElement.style.transform = 'translateX(-80px)';
          
          // Auto-hide after 3 seconds
          setTimeout(() => {
            cardElement.classList.remove('swiped');
            cardElement.style.transform = 'translateX(0)';
          }, 3000);
        } else {
          cardElement.style.transform = 'translateX(0)';
        }
        
        currentX = 0;
      });
    });
  }

  /**
   * Setup pull-to-refresh functionality
   */
  setupPullToRefresh() {
    const container = document.querySelector('main');
    if (!container) return;
    
    // Create pull-to-refresh indicator
    const refreshIndicator = document.createElement('div');
    refreshIndicator.className = 'pull-to-refresh';
    refreshIndicator.innerHTML = '<span>↓</span>';
    document.body.appendChild(refreshIndicator);
    
    let startY = 0;
    let currentY = 0;
    
    container.addEventListener('touchstart', (e) => {
      if (window.scrollY === 0 && !this.isRefreshing) {
        startY = e.touches[0].clientY;
      }
    }, { passive: true });
    
    container.addEventListener('touchmove', (e) => {
      if (!startY || this.isRefreshing) return;
      
      currentY = e.touches[0].clientY;
      this.pullDistance = currentY - startY;
      
      if (this.pullDistance > 0 && window.scrollY === 0) {
        e.preventDefault();
        
        // Show indicator when pulled down
        if (this.pullDistance > 20) {
          refreshIndicator.classList.add('visible');
          refreshIndicator.style.transform = `translateX(-50%) rotate(${this.pullDistance * 2}deg)`;
        }
        
        // Add resistance
        const resistance = Math.min(this.pullDistance / 3, 60);
        container.style.transform = `translateY(${resistance}px)`;
      }
    }, { passive: false });
    
    container.addEventListener('touchend', () => {
      if (this.pullDistance > 80 && !this.isRefreshing) {
        this.triggerRefresh(refreshIndicator, container);
      } else {
        this.resetPullToRefresh(refreshIndicator, container);
      }
      
      startY = 0;
      currentY = 0;
      this.pullDistance = 0;
    });
  }

  triggerRefresh(indicator, container) {
    this.isRefreshing = true;
    indicator.classList.add('refreshing');
    
    // Vibrate for feedback
    this.vibrate(50);
    
    // Refresh the page or fetch new data
    setTimeout(() => {
      window.location.reload();
    }, 1000);
  }

  resetPullToRefresh(indicator, container) {
    indicator.classList.remove('visible', 'refreshing');
    container.style.transform = 'translateY(0)';
    container.style.transition = 'transform 0.3s ease';
    
    setTimeout(() => {
      container.style.transition = '';
    }, 300);
  }

  /**
   * Setup mobile audio player
   */
  setupMobileAudioPlayer() {
    // Create mobile audio player container
    const playerContainer = document.createElement('div');
    playerContainer.className = 'audio-player-mobile';
    playerContainer.innerHTML = `
      <audio controls preload="none"></audio>
      <button class="btn btn-sm btn-secondary close-player" style="position: absolute; top: 5px; right: 5px;">✕</button>
    `;
    document.body.appendChild(playerContainer);
    
    this.audioPlayer = playerContainer.querySelector('audio');
    
    // Handle play button clicks
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('play-button')) {
        e.preventDefault();
        const mp3Path = e.target.dataset.mp3;
        this.playAudio(mp3Path, playerContainer);
      }
    });
    
    // Close player
    playerContainer.querySelector('.close-player').addEventListener('click', () => {
      this.closeAudioPlayer(playerContainer);
    });
    
    // Handle audio ended
    this.audioPlayer.addEventListener('ended', () => {
      setTimeout(() => {
        this.closeAudioPlayer(playerContainer);
      }, 1000);
    });
  }

  playAudio(mp3Path, playerContainer) {
    if (!mp3Path) return;
    
    // Vibrate for feedback
    this.vibrate(25);
    
    // Update audio source
    this.audioPlayer.src = mp3Path;
    this.audioPlayer.play();
    
    // Show player
    playerContainer.classList.add('active');
    document.body.classList.add('audio-playing');
    
    // Track currently playing
    this.currentlyPlaying = mp3Path;
    
    // Update play button states
    document.querySelectorAll('.play-button').forEach(btn => {
      if (btn.dataset.mp3 === mp3Path) {
        btn.innerHTML = '⏸';
        btn.classList.add('playing');
      } else {
        btn.innerHTML = '▶';
        btn.classList.remove('playing');
      }
    });
  }

  closeAudioPlayer(playerContainer) {
    this.audioPlayer.pause();
    playerContainer.classList.remove('active');
    document.body.classList.remove('audio-playing');
    
    // Reset play buttons
    document.querySelectorAll('.play-button').forEach(btn => {
      btn.innerHTML = '▶';
      btn.classList.remove('playing');
    });
    
    this.currentlyPlaying = null;
  }

  /**
   * Setup offline detection
   */
  setupOfflineDetection() {
    // Skip offline detection for local network addresses
    // navigator.onLine is unreliable for local HTTPS connections
    const isLocalNetwork = window.location.hostname.match(/^192\.168\.|^10\.|^172\./) || 
                          window.location.hostname === 'localhost';
    
    if (isLocalNetwork) {
      console.log('Skipping offline detection for local network address');
      return; // Don't show offline indicator for local networks
    }
    
    const offlineIndicator = document.createElement('div');
    offlineIndicator.className = 'offline-indicator';
    offlineIndicator.textContent = 'You are offline - Some features may be limited';
    document.body.appendChild(offlineIndicator);
    
    const updateOnlineStatus = () => {
      if (!navigator.onLine) {
        offlineIndicator.classList.add('show');
      } else {
        offlineIndicator.classList.remove('show');
      }
    };
    
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    
    // Check initial status
    updateOnlineStatus();
  }

  /**
   * Vibration feedback for interactions
   */
  setupVibrationFeedback() {
    // Add vibration to button clicks
    document.querySelectorAll('button, .btn').forEach(button => {
      button.addEventListener('click', () => {
        this.vibrate(10);
      });
    });
  }

  vibrate(duration) {
    if ('vibrate' in navigator) {
      navigator.vibrate(duration);
    }
  }

  /**
   * Optimize scrolling performance
   */
  optimizeScrolling() {
    let ticking = false;
    
    function requestTick() {
      if (!ticking) {
        requestAnimationFrame(updateScroll);
        ticking = true;
      }
    }
    
    function updateScroll() {
      // Add/remove classes based on scroll position
      const scrollY = window.scrollY;
      const navbar = document.querySelector('.navbar');
      
      if (scrollY > 100) {
        navbar?.classList.add('scrolled');
      } else {
        navbar?.classList.remove('scrolled');
      }
      
      ticking = false;
    }
    
    // Use passive listener for better performance
    window.addEventListener('scroll', requestTick, { passive: true });
  }

  /**
   * Handle orientation changes
   */
  setupOrientationHandler() {
    const handleOrientationChange = () => {
      const orientation = window.innerHeight > window.innerWidth ? 'portrait' : 'landscape';
      document.body.dataset.orientation = orientation;
      
      // Adjust layout based on orientation
      if (orientation === 'landscape' && this.isMobile()) {
        document.body.classList.add('mobile-landscape');
      } else {
        document.body.classList.remove('mobile-landscape');
      }
    };
    
    window.addEventListener('orientationchange', handleOrientationChange);
    window.addEventListener('resize', handleOrientationChange);
    
    // Check initial orientation
    handleOrientationChange();
  }

  /**
   * Setup Progressive Web App features
   */
  setupPWA() {
    // Register service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').then(registration => {
        console.log('ServiceWorker registered:', registration);
      }).catch(error => {
        console.log('ServiceWorker registration failed:', error);
      });
    }
    
    // Handle install prompt
    let deferredPrompt;
    
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      
      // Show install button
      const installBtn = document.createElement('button');
      installBtn.className = 'btn btn-primary install-pwa';
      installBtn.textContent = 'Install App';
      installBtn.style.cssText = 'position: fixed; bottom: 20px; right: 20px; z-index: 1030;';
      
      installBtn.addEventListener('click', () => {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choiceResult) => {
          if (choiceResult.outcome === 'accepted') {
            console.log('User accepted the install prompt');
          }
          deferredPrompt = null;
          installBtn.remove();
        });
      });
      
      document.body.appendChild(installBtn);
    });
  }
}

// Initialize mobile enhancements when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new MobileEnhancements();
});

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MobileEnhancements;
}