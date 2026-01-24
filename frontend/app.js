/**
 * Main Application
 *
 * Coordinates clock sync, WebSocket connection, and audio playback.
 */

class UnisongApp {
    constructor() {
        this.clockSync = new ClockSync();
        this.audioPlayer = new AudioPlayer();
        this.websocket = null;
        this.role = 'slave';  // 'master' or 'slave'
        this.roomId = 'default';
        this.isInitialized = false;

        // Track list state
        this.trackList = [];
        this.selectedTrackUrl = '';
        this.currentTrackIndex = 0;

        // UI elements
        this.statusEl = null;
        this.roleEl = null;
        this.offsetEl = null;
        this.rttStatsEl = null;
        this.playBtn = null;
        this.startBtn = null;
        this.logEl = null;
        this.trackSelectEl = null;
    }

    /**
     * Parse URL parameters.
     */
    parseUrlParams() {
        const params = new URLSearchParams(window.location.search);
        this.role = params.get('role') || 'slave';
        this.roomId = params.get('room') || 'default';
    }

    /**
     * Initialize UI element references.
     */
    initUI() {
        this.statusEl = document.getElementById('status');
        this.roleEl = document.getElementById('role');
        this.offsetEl = document.getElementById('offset');
        this.rttStatsEl = document.getElementById('rttStats');
        this.playBtn = document.getElementById('playBtn');
        this.startBtn = document.getElementById('startBtn');
        this.logEl = document.getElementById('log');
        this.trackSelectEl = document.getElementById('trackSelect');

        // Set role display
        this.roleEl.textContent = this.role.toUpperCase();
        this.roleEl.className = `role-badge ${this.role}`;

        // Only master can trigger play
        if (this.role !== 'master') {
            this.playBtn.style.display = 'none';
        }

        // Event listeners
        this.startBtn.addEventListener('click', () => this.start());
        this.playBtn.addEventListener('click', () => this.triggerPlay());

        // Track selection listener
        this.trackSelectEl.addEventListener('change', (e) => {
            this.selectedTrackUrl = e.target.value;
            // Find index for auto-next
            this.currentTrackIndex = this.trackList.findIndex(t => t.url === this.selectedTrackUrl);
            this.log(`Selected track: ${this.selectedTrackUrl}`);
        });
    }

    /**
     * Log a message to the UI.
     */
    log(message) {
        const time = new Date().toLocaleTimeString();
        const entry = document.createElement('div');
        entry.textContent = `[${time}] ${message}`;
        this.logEl.appendChild(entry);
        this.logEl.scrollTop = this.logEl.scrollHeight;
        console.log(message);
    }

    /**
     * Update status display.
     */
    setStatus(status) {
        this.statusEl.textContent = status;
    }

    /**
     * Fetch available tracks from server.
     */
    async fetchTrackList() {
        const response = await fetch('/api/songs');
        const data = await response.json();
        this.trackList = data.songs;

        // Populate dropdown
        this.trackSelectEl.innerHTML = '';
        if (this.trackList.length === 0) {
            this.trackSelectEl.innerHTML = '<option value="">No tracks available</option>';
            return;
        }

        this.trackList.forEach((track, index) => {
            const option = document.createElement('option');
            option.value = track.url;
            option.textContent = track.title;
            this.trackSelectEl.appendChild(option);
        });

        // Select first track by default
        this.selectedTrackUrl = this.trackList[0].url;
        this.currentTrackIndex = 0;
    }

    /**
     * Start the application (called from user click).
     */
    async start() {
        this.startBtn.disabled = true;
        this.setStatus('Initializing...');

        try {
            // Initialize audio context (requires user gesture)
            this.log('Initializing audio context...');
            await this.audioPlayer.initialize();

            // Set up track ended callback for auto-next
            this.audioPlayer.onTrackEnded = () => this.handleTrackEnded();

            // Fetch track list (don't preload audio - load on demand)
            this.log('Fetching track list...');
            await this.fetchTrackList();
            this.log(`Found ${this.trackList.length} tracks`);

            // Sync clock
            this.log('Synchronizing clock with server...');
            const syncResult = await this.clockSync.sync();
            this.offsetEl.textContent = `${syncResult.offset.toFixed(0)}ms`;
            this.log(`Clock synced: offset=${syncResult.offset.toFixed(0)}ms`);

            // Display RTT diagnostics
            const rttStats = window.syncDiagnostics?.getRttStats();
            if (rttStats) {
                this.rttStatsEl.textContent = `${rttStats.min}/${rttStats.max}ms`;
            }

            // Connect WebSocket
            this.log('Connecting to WebSocket...');
            await this.connectWebSocket();

            this.isInitialized = true;
            this.setStatus('Ready');
            this.log('Ready! Waiting for play command...');

            if (this.role === 'master') {
                this.playBtn.disabled = false;
            }

        } catch (error) {
            this.setStatus('Error');
            this.log(`Error: ${error.message}`);
            console.error(error);
            this.startBtn.disabled = false;
        }
    }

    /**
     * Connect to WebSocket server.
     */
    connectWebSocket() {
        return new Promise((resolve, reject) => {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws?room_id=${this.roomId}`;

            this.websocket = new WebSocket(wsUrl);

            this.websocket.onopen = () => {
                this.log('WebSocket connected');
                resolve();
            };

            this.websocket.onerror = (error) => {
                this.log('WebSocket error');
                reject(new Error('WebSocket connection failed'));
            };

            this.websocket.onclose = () => {
                this.log('WebSocket disconnected');
                if (this.isInitialized) {
                    this.setStatus('Disconnected');
                    // Could implement reconnection logic here
                }
            };

            this.websocket.onmessage = (event) => {
                this.handleMessage(JSON.parse(event.data));
            };
        });
    }

    /**
     * Handle incoming WebSocket message.
     */
    handleMessage(message) {
        this.log(`Received: ${message.type}`);
        console.log('[App] WebSocket message:', message);

        switch (message.type) {
            case 'time_sync':
                // Optional: could update clock offset here
                this.log(`Server time sync: ${message.server_time}`);
                break;

            case 'EVENT_TYPE_PLAY_SCHEDULED':
                this.handlePlayScheduled(message.play_at, message.server_time, message.track_url);
                break;

            default:
                this.log(`Unknown message type: ${message.type}`);
        }
    }

    /**
     * Handle play scheduled event - follows critical sequence: stop → load → schedule.
     */
    async handlePlayScheduled(playAtServerTime, serverTime, trackUrl) {
        this.log(`Play scheduled: track=${trackUrl}`);
        console.log('[App] handlePlayScheduled called', { playAtServerTime, serverTime, trackUrl });

        // Check if audio context is initialized
        if (!this.audioPlayer.audioContext) {
            this.log('ERROR: Audio not initialized. Click "Start" first!');
            console.error('[App] Audio context not initialized');
            return;
        }

        // STEP 1: Stop current playback and clear buffer
        this.audioPlayer.stop();

        // STEP 2: Load fresh audio buffer
        this.log(`Loading audio: ${trackUrl}`);
        this.setStatus('Loading...');
        try {
            await this.audioPlayer.loadAudio(trackUrl);
        } catch (error) {
            this.log(`Error loading audio: ${error.message}`);
            this.setStatus('Error');
            return;
        }

        // Update current track index for auto-next
        const trackIndex = this.trackList.findIndex(t => t.url === trackUrl);
        if (trackIndex !== -1) {
            this.currentTrackIndex = trackIndex;
            // Update dropdown to show current track
            this.trackSelectEl.value = trackUrl;
        }

        // STEP 3: Schedule playback
        const playAtLocalTime = this.clockSync.serverToLocal(playAtServerTime);
        const now = Date.now();
        const delayMs = playAtLocalTime - now;

        this.log(`Scheduling playback: delay=${delayMs}ms`);

        // Schedule the playback
        try {
            await this.audioPlayer.schedulePlayback(playAtLocalTime);
        } catch (error) {
            this.log(`Error scheduling playback: ${error.message}`);
            console.error('[App] Scheduling error:', error);
            this.setStatus('Error');
            return;
        }

        this.setStatus(`Playing in ${Math.max(0, Math.round(delayMs))}ms...`);

        // Update status when playback starts
        setTimeout(() => {
            if (this.audioPlayer.isPlaying) {
                this.setStatus('Playing');
            }
        }, Math.max(0, delayMs + 100));
    }

    /**
     * Handle track ended - auto-next (master only triggers server request).
     */
    handleTrackEnded() {
        this.log('Track ended');
        this.setStatus('Ready');

        // Only master triggers auto-next
        if (this.role !== 'master') {
            this.log('Waiting for master to trigger next track...');
            return;
        }

        // Calculate next track index (wrap around)
        const nextIndex = (this.currentTrackIndex + 1) % this.trackList.length;
        this.selectedTrackUrl = this.trackList[nextIndex].url;
        this.trackSelectEl.value = this.selectedTrackUrl;

        this.log(`Auto-next: playing track ${nextIndex + 1}/${this.trackList.length}`);

        // Trigger server request (NOT direct playback)
        this.triggerPlay();
    }

    /**
     * Trigger play command (master only).
     */
    async triggerPlay() {
        if (this.role !== 'master') {
            this.log('Only master can trigger play');
            return;
        }

        if (!this.selectedTrackUrl) {
            this.log('No track selected');
            return;
        }

        this.playBtn.disabled = true;
        this.log(`Triggering play: ${this.selectedTrackUrl}`);

        try {
            const params = new URLSearchParams({
                room_id: this.roomId,
                track_url: this.selectedTrackUrl,
            });
            const response = await fetch(`/api/play?${params}`, {
                method: 'POST',
            });
            const data = await response.json();
            this.log(`Play scheduled: play_at=${data.play_at}`);
        } catch (error) {
            this.log(`Error triggering play: ${error.message}`);
        }

        // Re-enable button after a delay
        setTimeout(() => {
            this.playBtn.disabled = false;
        }, 1000);
    }

    /**
     * Initialize the application.
     */
    init() {
        this.parseUrlParams();
        this.initUI();
        this.log(`Unisong initialized (role: ${this.role}, room: ${this.roomId})`);
        this.log('Click "Start" to initialize audio and connect');
    }
}

// Start app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new UnisongApp();
    app.init();
    // Expose for debugging
    window.app = app;
});
