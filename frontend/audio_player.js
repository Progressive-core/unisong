/**
 * Audio Player Module
 *
 * Uses Web Audio API for precise scheduled playback.
 * The key is using AudioBufferSourceNode.start(when) which allows
 * scheduling playback at a specific audioContext time.
 */

class AudioPlayer {
    constructor() {
        this.audioContext = null;
        this.audioBuffer = null;
        this.sourceNode = null;
        this.isPlaying = false;
        this.loadedUrl = null;
        this.onTrackEnded = null;  // Callback for when track finishes naturally
        this.bufferCache = {};  // Cache for iOS to store multiple buffers
    }

    /**
     * Initialize the AudioContext.
     * Must be called from a user gesture (click) due to browser autoplay policies.
     */
    async initialize() {
        if (this.audioContext) {
            return;
        }

        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

        // Resume if suspended (required by some browsers)
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }

        console.log('[AudioPlayer] Initialized, context time:', this.audioContext.currentTime);
        console.log('[AudioPlayer] Initial state:', this.audioContext.state);

        // iOS/Mobile unlock: Play silent buffer to unlock audio
        const isMobile = /iPad|iPhone|iPod|Android|webOS|BlackBerry|Windows Phone/i.test(navigator.userAgent) ||
                       (navigator.maxTouchPoints && navigator.maxTouchPoints > 2);
        if (isMobile) {
            console.log('[AudioPlayer] Mobile detected, playing unlock buffer');
            const buffer = this.audioContext.createBuffer(1, 1, 22050);
            const source = this.audioContext.createBufferSource();
            source.buffer = buffer;
            source.connect(this.audioContext.destination);
            source.start(0);
            console.log('[AudioPlayer] Mobile unlock buffer played');
        }
    }

    /**
     * Load and decode an audio file.
     * Uses cache if available (for mobile preloading).
     */
    async loadAudio(url) {
        if (!this.audioContext) {
            throw new Error('AudioContext not initialized. Call initialize() first.');
        }

        // Check cache first (mobile preloading)
        if (this.bufferCache[url]) {
            console.log('[AudioPlayer] Using cached audio:', url);
            this.audioBuffer = this.bufferCache[url];
            this.loadedUrl = url;
            console.log('[AudioPlayer] Cached audio loaded, duration:', this.audioBuffer.duration, 'seconds');
            return this.audioBuffer.duration;
        }

        console.log('[AudioPlayer] Loading audio:', url);

        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        this.audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
        this.loadedUrl = url;

        console.log('[AudioPlayer] Audio loaded, duration:', this.audioBuffer.duration, 'seconds');

        return this.audioBuffer.duration;
    }

    /**
     * Get current audio context time.
     */
    getCurrentTime() {
        return this.audioContext ? this.audioContext.currentTime : 0;
    }

    /**
     * Schedule playback to start at a specific local time (Date.now() style).
     *
     * @param {number} playAtLocalTime - Unix timestamp in ms when playback should start
     */
    async schedulePlayback(playAtLocalTime) {
        if (!this.audioContext || !this.audioBuffer) {
            throw new Error('Audio not loaded');
        }

        console.log('[AudioPlayer] AudioContext state:', this.audioContext.state);

        // Resume audio context if suspended (important for iOS and some browsers)
        if (this.audioContext.state === 'suspended') {
            console.log('[AudioPlayer] Resuming suspended AudioContext');
            await this.audioContext.resume();
            console.log('[AudioPlayer] AudioContext resumed, new state:', this.audioContext.state);
        }

        // iOS workaround: Double-check state after resume attempt
        if (this.audioContext.state !== 'running') {
            console.warn('[AudioPlayer] AudioContext not running after resume attempt!');
            await this.audioContext.resume();
            console.log('[AudioPlayer] Second resume attempt, state:', this.audioContext.state);
        }

        // Stop any existing playback if there's a source node
        if (this.sourceNode) {
            console.log('[AudioPlayer] Stopping existing source node');
            try {
                this.sourceNode.stop();
                this.sourceNode.disconnect();
            } catch (e) {
                // Ignore errors if already stopped
            }
            this.sourceNode = null;
            this.isPlaying = false;
        }

        // Calculate delay from now
        const now = Date.now();
        const rawDelayMs = playAtLocalTime - now;
        let delayMs = rawDelayMs;

        if (delayMs < 0) {
            // Playback time already passed due to timing quantization
            delayMs = 0;
        }

        // Record delay metrics to diagnostics
        if (window.syncDiagnostics) {
            window.syncDiagnostics.recordPlaybackDelay(rawDelayMs, delayMs);
        }

        // Convert to audio context time (seconds)
        const delaySeconds = delayMs / 1000;
        const startTime = this.audioContext.currentTime + delaySeconds;

        console.log('[AudioPlayer] Current context time:', this.audioContext.currentTime);
        console.log('[AudioPlayer] Start time:', startTime);
        console.log('[AudioPlayer] Delay seconds:', delaySeconds);

        // Create and configure source node
        this.sourceNode = this.audioContext.createBufferSource();
        this.sourceNode.buffer = this.audioBuffer;
        this.sourceNode.connect(this.audioContext.destination);

        console.log('[AudioPlayer] Source connected to destination:', this.audioContext.destination);
        console.log('[AudioPlayer] Buffer duration:', this.audioBuffer.duration, 'seconds');

        // Handle playback end
        this.sourceNode.onended = () => {
            // Only trigger callback if we were actually playing
            // (not if stop() was called manually)
            const wasPlaying = this.isPlaying;
            this.isPlaying = false;
            console.log('[AudioPlayer] Playback ended, wasPlaying:', wasPlaying);

            // Only trigger auto-next if track finished naturally
            if (wasPlaying && this.onTrackEnded) {
                this.onTrackEnded();
            }
        };

        // Schedule the start
        try {
            this.sourceNode.start(startTime);
            this.isPlaying = true;
            console.log(`[AudioPlayer] Scheduled to start in ${delayMs}ms (at context time ${startTime.toFixed(3)}s)`);
            console.log(`[AudioPlayer] Source node created and scheduled successfully`);
        } catch (error) {
            console.error('[AudioPlayer] Error starting source node:', error);
            throw error;
        }

        return {
            scheduledDelay: delayMs,
            contextStartTime: startTime,
        };
    }

    /**
     * Stop current playback and clear buffer to ensure fresh load.
     */
    stop() {
        if (this.sourceNode) {
            // Clear onended handler to prevent it from firing
            this.sourceNode.onended = null;
            try {
                this.sourceNode.stop();
                this.sourceNode.disconnect();
            } catch (e) {
                // Ignore errors if already stopped
            }
            this.sourceNode = null;
        }
        this.isPlaying = false;
        // Clear buffer to ensure fresh load for next track
        this.audioBuffer = null;
        this.loadedUrl = null;
    }

    /**
     * Check if audio is ready to play.
     */
    isReady() {
        return this.audioContext !== null && this.audioBuffer !== null;
    }
}

// Export for use in other modules
window.AudioPlayer = AudioPlayer;
