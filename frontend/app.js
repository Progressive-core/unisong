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

        // UI elements
        this.statusEl = null;
        this.roleEl = null;
        this.offsetEl = null;
        this.playBtn = null;
        this.startBtn = null;
        this.logEl = null;
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
        this.playBtn = document.getElementById('playBtn');
        this.startBtn = document.getElementById('startBtn');
        this.logEl = document.getElementById('log');

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
     * Start the application (called from user click).
     */
    async start() {
        this.startBtn.disabled = true;
        this.setStatus('Initializing...');

        try {
            // Initialize audio context (requires user gesture)
            this.log('Initializing audio context...');
            await this.audioPlayer.initialize();

            // Load audio file
            this.log('Loading audio file...');
            await this.audioPlayer.loadAudio('/songs/Aerial%20Boundaries.mp3');

            // Sync clock
            this.log('Synchronizing clock with server...');
            const syncResult = await this.clockSync.sync();
            this.offsetEl.textContent = `${syncResult.offset.toFixed(0)}ms`;
            this.log(`Clock synced: offset=${syncResult.offset.toFixed(0)}ms`);

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

        switch (message.type) {
            case 'time_sync':
                // Optional: could update clock offset here
                this.log(`Server time sync: ${message.server_time}`);
                break;

            case 'EVENT_TYPE_PLAY_SCHEDULED':
                this.schedulePlayback(message.play_at, message.server_time);
                break;

            default:
                this.log(`Unknown message type: ${message.type}`);
        }
    }

    /**
     * Schedule audio playback for the given server time.
     */
    schedulePlayback(playAtServerTime, serverTime) {
        if (!this.audioPlayer.isReady()) {
            this.log('Error: Audio not ready');
            return;
        }

        // Convert server time to local time
        const playAtLocalTime = this.clockSync.serverToLocal(playAtServerTime);
        const now = Date.now();
        const delayMs = playAtLocalTime - now;

        this.log(`Scheduling playback: server_time=${playAtServerTime}, local_time=${playAtLocalTime}, delay=${delayMs}ms`);

        // Schedule the playback
        const result = this.audioPlayer.schedulePlayback(playAtLocalTime);

        this.setStatus(`Playing in ${Math.max(0, Math.round(delayMs))}ms...`);

        // Update status when playback starts
        setTimeout(() => {
            if (this.audioPlayer.isPlaying) {
                this.setStatus('Playing');
            }
        }, Math.max(0, delayMs + 100));
    }

    /**
     * Trigger play command (master only).
     */
    async triggerPlay() {
        if (this.role !== 'master') {
            this.log('Only master can trigger play');
            return;
        }

        this.playBtn.disabled = true;

        // Compute adaptive lead time based on observed network conditions
        const leadTime = this.clockSync.getAdaptiveLeadTime();
        this.log(`Triggering play with lead_time=${leadTime}ms...`);

        try {
            const response = await fetch(`/api/play?room_id=${this.roomId}&lead_time=${leadTime}`, {
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
});
