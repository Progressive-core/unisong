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
        this.nextTrackPreloadTimer = null;  // Timer for preloading next track
        this.isMobile = false;
        this.roomStatus = null;  // Room status (clients and their ready state)

        // YouTube download state
        this.youtubePanel = null;
        this.youtubeUrlInput = null;
        this.youtubeDownloadBtn = null;
        this.youtubeProgress = null;
        this.youtubeProgressFill = null;
        this.youtubeProgressText = null;
        this.youtubeStatus = null;
        this.isDownloading = false;

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

        // Only master can trigger play and see client list
        if (this.role !== 'master') {
            this.playBtn.style.display = 'none';
        } else {
            // Show client list for master
            const clientListCard = document.getElementById('clientListCard');
            if (clientListCard) {
                clientListCard.style.display = 'block';
            }
            // Initialize YouTube panel for master
            this.initYoutubePanel();
            // Initialize QR code for master
            this.initQRCode();
        }

        // Event listeners
        this.startBtn.addEventListener('click', () => {
            if (this.isInitialized) {
                this.stop();
            } else {
                this.start();
            }
        });
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
     * Initialize YouTube download panel (master only).
     */
    initYoutubePanel() {
        this.youtubePanel = document.getElementById('youtubePanel');
        this.youtubeUrlInput = document.getElementById('youtubeUrlInput');
        this.youtubeDownloadBtn = document.getElementById('youtubeDownloadBtn');
        this.youtubeProgress = document.getElementById('youtubeProgress');
        this.youtubeProgressFill = document.getElementById('youtubeProgressFill');
        this.youtubeProgressText = document.getElementById('youtubeProgressText');
        this.youtubeStatus = document.getElementById('youtubeStatus');

        document.getElementById('youtubeToggleBtn').style.display = 'flex';
        document.getElementById('youtubeToggleBtn').addEventListener('click',
            () => this.toggleYoutubePanel());
        document.getElementById('youtubePanelOverlay').addEventListener('click',
            () => this.closeYoutubePanel());
        document.getElementById('youtubePanelClose').addEventListener('click',
            () => this.closeYoutubePanel());
        this.youtubeDownloadBtn.addEventListener('click',
            () => this.startYoutubeDownload());
        this.youtubeUrlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !this.isDownloading) {
                this.startYoutubeDownload();
            }
        });
    }

    /**
     * Initialize QR code for slave devices to scan (master only).
     */
    async initQRCode() {
        try {
            // Fetch network info from server
            const response = await fetch('/api/network-info');
            const data = await response.json();

            // Show QR code card
            const qrCodeCard = document.getElementById('qrCodeCard');
            if (qrCodeCard) {
                qrCodeCard.style.display = 'block';
            }

            // Clear any existing QR code
            const qrElement = document.getElementById('qrcode');
            qrElement.innerHTML = '';

            // Generate QR code with connection URL
            new QRCode(qrElement, {
                text: data.slave_url,
                width: 256,
                height: 256,
                colorDark: '#000000',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.H
            });

            // Display URL below QR code
            const urlElement = document.getElementById('connectionUrl');
            if (urlElement) {
                urlElement.textContent = data.slave_url;
            }

            this.log(`QR code generated for: ${data.slave_url}`);
        } catch (error) {
            console.error('Failed to generate QR code:', error);
            this.log('Failed to generate QR code');
        }
    }

    /**
     * Toggle YouTube panel visibility.
     */
    toggleYoutubePanel() {
        if (this.youtubePanel.classList.contains('active')) {
            this.closeYoutubePanel();
        } else {
            this.youtubePanel.classList.add('active');
            this.youtubePanel.style.display = 'block';
            setTimeout(() => this.youtubeUrlInput.focus(), 300);
        }
    }

    /**
     * Close YouTube panel.
     */
    closeYoutubePanel() {
        this.youtubePanel.classList.remove('active');
        setTimeout(() => {
            if (!this.youtubePanel.classList.contains('active')) {
                this.youtubePanel.style.display = 'none';
            }
        }, 300);
    }

    /**
     * Start YouTube download.
     */
    async startYoutubeDownload() {
        const url = this.youtubeUrlInput.value.trim();

        if (!url) {
            this.showYoutubeStatus('Please enter a YouTube URL', 'error');
            return;
        }

        if (!this.isValidYoutubeUrl(url)) {
            this.showYoutubeStatus('Invalid YouTube URL', 'error');
            return;
        }

        this.isDownloading = true;
        this.youtubeDownloadBtn.disabled = true;
        this.youtubeUrlInput.disabled = true;
        this.youtubeProgress.style.display = 'block';
        this.youtubeProgressFill.style.width = '0%';
        this.youtubeStatus.style.display = 'none';
        this.log(`Starting YouTube download: ${url}`);

        try {
            const params = new URLSearchParams({
                room_id: this.roomId,
                url: url,
            });
            const response = await fetch(`/api/youtube/download?${params}`, {
                method: 'POST',
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Download failed');
            }
        } catch (error) {
            this.log(`Download error: ${error.message}`);
            this.showYoutubeStatus(error.message, 'error');
            this.resetYoutubePanel();
        }
    }

    /**
     * Validate YouTube URL format.
     */
    isValidYoutubeUrl(url) {
        return /^(https?:\/\/)?(www\.)?(youtube|youtu|youtube-nocookie)\.(com|be)\/.+$/.test(url);
    }

    /**
     * Show status message in YouTube panel.
     */
    showYoutubeStatus(message, type = 'error') {
        this.youtubeStatus.textContent = message;
        this.youtubeStatus.className = `youtube-status ${type}`;
        this.youtubeStatus.style.display = 'block';
    }

    /**
     * Reset YouTube panel state.
     */
    resetYoutubePanel() {
        this.isDownloading = false;
        this.youtubeDownloadBtn.disabled = false;
        this.youtubeUrlInput.disabled = false;
        this.youtubeProgress.style.display = 'none';
    }

    /**
     * Handle YouTube download progress update.
     */
    handleYoutubeProgress(progress) {
        const percent = Math.round(progress);
        this.youtubeProgressFill.style.width = `${percent}%`;
        this.youtubeProgressText.textContent = `${percent}%`;
        this.log(`Download progress: ${percent}%`);
    }

    /**
     * Handle YouTube download completion.
     */
    async handleYoutubeComplete(status, error) {
        if (status === 'success') {
            this.log('Download complete! Refreshing track list...');
            this.showYoutubeStatus('Download complete!', 'success');
            await this.fetchTrackList();
            this.youtubeUrlInput.value = '';
            setTimeout(() => {
                this.closeYoutubePanel();
                this.resetYoutubePanel();
            }, 2000);
        } else {
            this.log(`Download failed: ${error}`);
            this.showYoutubeStatus(error || 'Download failed', 'error');
            this.resetYoutubePanel();
        }
    }

    /**
     * Handle volume change (slave only).
     */
    handleVolumeChange(volume) {
        if (this.role === 'master') return;  // Only slaves respond to volume changes

        this.audioPlayer.setVolume(volume);
        this.log(`Volume set to ${(volume * 100).toFixed(0)}%`);
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
     * Send ready message to server.
     */
    sendReady(trackUrl) {
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
            this.websocket.send(JSON.stringify({
                type: 'client_ready',
                track_url: trackUrl,
            }));
            this.log(`Sent ready: ${trackUrl}`);
        }
    }

    /**
     * Send not-ready message to server.
     */
    sendNotReady() {
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
            this.websocket.send(JSON.stringify({
                type: 'client_not_ready',
            }));
            this.log('Sent not ready');
        }
    }

    /**
     * Set volume for a specific client (master only).
     */
    setClientVolume(clientId, volume) {
        if (this.role !== 'master') return;

        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
            this.websocket.send(JSON.stringify({
                type: 'set_volume',
                target_client: clientId,
                volume: volume,
            }));
            console.log(`[App] Set ${clientId} volume to ${(volume * 100).toFixed(0)}%`);
        }
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

            // Fetch track list
            this.log('Fetching track list...');
            await this.fetchTrackList();
            this.log(`Found ${this.trackList.length} tracks`);

            // Detect mobile (for smart preloading strategy)
            this.isMobile = /iPad|iPhone|iPod|Android|webOS|BlackBerry|Windows Phone/i.test(navigator.userAgent) ||
                           (navigator.maxTouchPoints && navigator.maxTouchPoints > 2);
            this.log(`Mobile detected: ${this.isMobile}, UA: ${navigator.userAgent.substring(0, 50)}...`);

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

            // Change button to "Stop"
            this.startBtn.textContent = 'Stop';
            this.startBtn.disabled = false;

        } catch (error) {
            this.setStatus('Error');
            this.log(`Error: ${error.message}`);
            console.error(error);
            this.startBtn.disabled = false;
        }
    }

    /**
     * Stop all playback and disconnect.
     */
    stop() {
        this.log('Stopping...');

        // If master, send stop command to all slaves
        if (this.role === 'master' && this.websocket && this.websocket.readyState === WebSocket.OPEN) {
            this.websocket.send(JSON.stringify({
                type: 'stop_all',
            }));
            this.log('Sent stop command to all clients');
        }

        // Stop audio playback
        if (this.audioPlayer) {
            this.audioPlayer.stop();
        }

        // Close WebSocket
        if (this.websocket) {
            this.websocket.close();
            this.websocket = null;
        }

        // Reset state
        this.isInitialized = false;
        this.setStatus('Stopped');

        // Reset button
        this.startBtn.textContent = 'Start';
        this.startBtn.disabled = false;

        // Disable play button for master
        if (this.role === 'master' && this.playBtn) {
            this.playBtn.disabled = true;
            this.playBtn.textContent = 'Play';  // Reset to original text
        }

        this.log('Stopped. Click "Start" to reconnect.');
    }

    /**
     * Connect to WebSocket server.
     */
    connectWebSocket() {
        return new Promise((resolve, reject) => {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws?room_id=${this.roomId}&role=${this.role}`;

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

            case 'prepare_track':
                this.handlePrepareTrack(message.track_url);
                break;

            case 'EVENT_TYPE_PLAY_SCHEDULED':
                this.handlePlayScheduled(message.play_at, message.server_time, message.track_url);
                break;

            case 'room_status':
                this.handleRoomStatus(message.status);
                break;

            case 'youtube_download_progress':
                this.handleYoutubeProgress(message.progress);
                break;

            case 'youtube_download_complete':
                this.handleYoutubeComplete(message.status, message.error);
                break;

            case 'volume_change':
                this.handleVolumeChange(message.volume);
                break;

            case 'stop_all':
                // Master sent stop command to all clients
                if (this.role !== 'master') {
                    this.log('Master stopped all playback');
                    this.audioPlayer.stop();
                    this.setStatus('Stopped by master');
                }
                break;

            default:
                this.log(`Unknown message type: ${message.type}`);
        }
    }

    /**
     * Handle prepare track event - load track but don't play yet.
     */
    async handlePrepareTrack(trackUrl) {
        this.log(`Preparing track: ${trackUrl}`);
        console.log('[App] handlePrepareTrack called', { trackUrl });

        // Check if audio context is initialized
        if (!this.audioPlayer.audioContext) {
            this.log('ERROR: Audio not initialized. Click "Start" first!');
            console.error('[App] Audio context not initialized');
            return;
        }

        // STEP 1: Stop current playback
        this.audioPlayer.stop();

        // STEP 2: Load audio buffer (from cache or fetch)
        this.log(`Loading audio: ${trackUrl}`);
        this.setStatus('Loading...');
        this.sendNotReady();  // Notify server we're loading

        try {
            await this.audioPlayer.loadAudio(trackUrl);
            // Cache it for future use (mobile)
            if (this.isMobile) {
                this.audioPlayer.bufferCache[trackUrl] = this.audioPlayer.audioBuffer;
            }
            this.log('Track loaded, ready to play');
            this.setStatus('Ready - waiting for all clients...');
            this.sendReady(trackUrl);  // Notify server we're ready
        } catch (error) {
            this.log(`Error loading audio: ${error.message}`);
            this.setStatus('Error');
            return;
        }
    }

    /**
     * Handle play scheduled event - schedule playback (track already loaded).
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

        // Track should already be loaded from handlePrepareTrack
        // If not loaded (edge case), load it now
        if (this.audioPlayer.loadedUrl !== trackUrl && !this.audioPlayer.bufferCache[trackUrl]) {
            this.log(`Track not preloaded, loading now: ${trackUrl}`);
            try {
                await this.audioPlayer.loadAudio(trackUrl);
            } catch (error) {
                this.log(`Error loading audio: ${error.message}`);
                this.setStatus('Error');
                return;
            }
        } else if (this.audioPlayer.loadedUrl !== trackUrl) {
            // Load from cache
            await this.audioPlayer.loadAudio(trackUrl);
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

        // STEP 4: Schedule preloading of next track (smart preloading)
        this.scheduleNextTrackPreload();
    }

    /**
     * Schedule preloading of next track before current track ends.
     * Called after playback is scheduled.
     */
    scheduleNextTrackPreload() {
        // Cancel any existing preload timer
        if (this.nextTrackPreloadTimer) {
            clearTimeout(this.nextTrackPreloadTimer);
            this.nextTrackPreloadTimer = null;
        }

        // Get current track duration
        const duration = this.audioPlayer.audioBuffer?.duration;
        if (!duration) {
            return;
        }

        // Calculate next track index
        const nextIndex = (this.currentTrackIndex + 1) % this.trackList.length;
        const nextTrack = this.trackList[nextIndex];

        if (!nextTrack) {
            return;
        }

        // Schedule preload 10 seconds before track ends (or immediately if track < 15 seconds)
        const preloadTime = Math.max(0, (duration - 10) * 1000);

        this.log(`Will preload next track in ${(preloadTime / 1000).toFixed(1)}s: ${nextTrack.title}`);

        this.nextTrackPreloadTimer = setTimeout(async () => {
            // Check if already cached
            if (this.audioPlayer.bufferCache[nextTrack.url]) {
                this.log(`Next track already cached: ${nextTrack.title}`);
                return;
            }

            this.log(`Preloading next track: ${nextTrack.title}`);
            try {
                // Temporarily save current buffer
                const currentBuffer = this.audioPlayer.audioBuffer;
                const currentUrl = this.audioPlayer.loadedUrl;

                // Load next track
                await this.audioPlayer.loadAudio(nextTrack.url);

                // Cache it
                this.audioPlayer.bufferCache[nextTrack.url] = this.audioPlayer.audioBuffer;

                // Restore current buffer
                this.audioPlayer.audioBuffer = currentBuffer;
                this.audioPlayer.loadedUrl = currentUrl;

                this.log(`Next track preloaded: ${nextTrack.title}`);
            } catch (error) {
                this.log(`Warning: Could not preload next track: ${error.message}`);
            }
        }, preloadTime);
    }

    /**
     * Handle room status update.
     */
    handleRoomStatus(status) {
        this.roomStatus = status;
        console.log('[App] Room status:', status);

        // Only master needs to update UI based on room status
        if (this.role === 'master') {
            this.updateClientList(status);
            this.updatePlayButton(status);
        }
    }

    /**
     * Update client list display (master only).
     */
    updateClientList(status) {
        const clientListEl = document.getElementById('clientList');
        if (!clientListEl) return;

        clientListEl.innerHTML = '';
        status.clients.forEach(client => {
            const item = document.createElement('div');
            item.className = 'client-item';

            // Only show volume control for slaves (not for master clients)
            const volumeControl = client.role === 'slave' ? `
                <div class="volume-control">
                    <label class="volume-label">🔊</label>
                    <input
                        type="range"
                        class="volume-slider"
                        min="0"
                        max="100"
                        value="${Math.round((client.volume || 1.0) * 100)}"
                        data-client-id="${client.client_id}"
                    />
                    <span class="volume-value">${Math.round((client.volume || 1.0) * 100)}%</span>
                </div>
            ` : '';

            item.innerHTML = `
                <span class="client-id">${client.client_id}</span>
                <span class="client-status ${client.ready ? 'ready' : 'not-ready'}">
                    ${client.ready ? '✓ Ready' : '⌛ Loading...'}
                </span>
                ${volumeControl}
            `;
            clientListEl.appendChild(item);

            // Add event listeners for volume controls (only for slaves)
            if (client.role === 'slave') {
                const slider = item.querySelector('.volume-slider');
                const valueDisplay = item.querySelector('.volume-value');
                const muteButton = item.querySelector('.volume-label');

                // Store previous volume for unmute
                let previousVolume = client.volume || 1.0;
                let isMuted = false;

                if (slider && valueDisplay) {
                    // Slider change handler
                    slider.addEventListener('input', (e) => {
                        const volume = parseInt(e.target.value) / 100;
                        valueDisplay.textContent = e.target.value + '%';
                        this.setClientVolume(client.client_id, volume);

                        // Update mute state
                        if (volume > 0) {
                            isMuted = false;
                            previousVolume = volume;
                            muteButton.classList.remove('muted');
                            muteButton.textContent = '🔊';
                        } else {
                            isMuted = true;
                            muteButton.classList.add('muted');
                            muteButton.textContent = '🔇';
                        }
                    });
                }

                // Mute/unmute button handler
                if (muteButton) {
                    muteButton.addEventListener('click', () => {
                        if (isMuted) {
                            // Unmute: restore previous volume
                            const restoreVolume = previousVolume > 0 ? previousVolume : 1.0;
                            slider.value = Math.round(restoreVolume * 100);
                            valueDisplay.textContent = Math.round(restoreVolume * 100) + '%';
                            this.setClientVolume(client.client_id, restoreVolume);
                            isMuted = false;
                            muteButton.classList.remove('muted');
                            muteButton.textContent = '🔊';
                        } else {
                            // Mute: save current volume and set to 0
                            previousVolume = parseInt(slider.value) / 100;
                            slider.value = 0;
                            valueDisplay.textContent = '0%';
                            this.setClientVolume(client.client_id, 0);
                            isMuted = true;
                            muteButton.classList.add('muted');
                            muteButton.textContent = '🔇';
                        }
                    });
                }
            }
        });
    }

    /**
     * Update Play button state (master only).
     */
    updatePlayButton(status) {
        if (this.playBtn) {
            // Don't change button state if already playing
            if (this.audioPlayer.isPlaying) {
                return;
            }

            // Enable if all ready, disable if waiting
            const shouldEnable = status.all_ready && status.client_count > 0;
            this.playBtn.disabled = !shouldEnable;

            if (!status.all_ready && status.client_count > 0) {
                this.setStatus('Waiting for all clients...');
            } else if (shouldEnable && !this.audioPlayer.isPlaying) {
                this.setStatus('Ready');
                this.playBtn.disabled = false;  // Re-enable for next track
            }
        }
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
     * Phase 1: Tell all clients to prepare (load) the track.
     * Phase 2: When all ready, server auto-triggers play.
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
        this.log(`Preparing track for all clients: ${this.selectedTrackUrl}`);

        try {
            const params = new URLSearchParams({
                room_id: this.roomId,
                track_url: this.selectedTrackUrl,
            });
            const response = await fetch(`/api/prepare?${params}`, {
                method: 'POST',
            });
            const data = await response.json();
            this.log('All clients loading track...');
            this.setStatus('Waiting for all clients to load...');

            // Change button text to "Restart" after first play
            this.playBtn.textContent = 'Restart';
        } catch (error) {
            this.log(`Error preparing track: ${error.message}`);
            this.playBtn.disabled = false;
        }
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
