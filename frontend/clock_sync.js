/**
 * Clock Synchronization Module
 *
 * Calculates the offset between local time and server time
 * using multiple HTTP requests to measure RTT and estimate offset.
 */

// Adaptive lead time constants
const BASE_LEAD_TIME_MS = 2000;
const MIN_LEAD_TIME_MS = 2000;
const MAX_LEAD_TIME_MS = 8000;

class ClockSync {
    constructor(options = {}) {
        this.serverTimeUrl = options.serverTimeUrl || '/api/time';
        this.sampleCount = options.sampleCount || 5;
        this.sampleInterval = options.sampleInterval || 200; // ms between samples

        this.offset = 0;  // server_time - local_time
        this.lastSyncTime = 0;
        this.samples = [];
    }

    /**
     * Get current local time in milliseconds.
     */
    getLocalTime() {
        return Date.now();
    }

    /**
     * Get estimated server time based on local time + offset.
     */
    getServerTime() {
        return this.getLocalTime() + this.offset;
    }

    /**
     * Convert server time to local time.
     */
    serverToLocal(serverTime) {
        return serverTime - this.offset;
    }

    /**
     * Perform a single time sync sample.
     * Returns { offset, rtt }
     */
    async fetchTimeSample() {
        const t1 = this.getLocalTime();

        const response = await fetch(this.serverTimeUrl);
        const data = await response.json();

        const t4 = this.getLocalTime();
        const serverTime = data.server_time;

        // RTT = total round trip time
        const rtt = t4 - t1;

        // Estimate server time at midpoint of request
        // offset = server_time - (local_time at midpoint)
        // midpoint = t1 + rtt/2
        const offset = serverTime - (t1 + rtt / 2);

        return { offset, rtt };
    }

    /**
     * Perform multiple samples and calculate best offset estimate.
     */
    async sync() {
        console.log('[ClockSync] Starting synchronization...');
        this.samples = [];

        for (let i = 0; i < this.sampleCount; i++) {
            try {
                const sample = await this.fetchTimeSample();
                this.samples.push(sample);
                console.log(`[ClockSync] Sample ${i + 1}: offset=${sample.offset}ms, rtt=${sample.rtt}ms`);

                if (i < this.sampleCount - 1) {
                    await this.sleep(this.sampleInterval);
                }
            } catch (error) {
                console.error('[ClockSync] Sample failed:', error);
            }
        }

        if (this.samples.length === 0) {
            throw new Error('Clock sync failed: no successful samples');
        }

        // Use the sample with lowest RTT (most accurate)
        const bestSample = this.samples.reduce((best, sample) =>
            sample.rtt < best.rtt ? sample : best
        );

        this.offset = bestSample.offset;
        this.lastSyncTime = this.getLocalTime();

        console.log(`[ClockSync] Sync complete: offset=${this.offset}ms (best RTT=${bestSample.rtt}ms)`);

        return {
            offset: this.offset,
            bestRtt: bestSample.rtt,
            samples: this.samples.length,
        };
    }

    /**
     * Helper to sleep for ms milliseconds.
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Compute adaptive lead time based on observed RTT.
     * Must be called after sync().
     *
     * Formula:
     *   adaptive_lead_time = BASE_LEAD_TIME_MS + RTT_BUFFER + JITTER_BUFFER
     *   RTT_BUFFER = best_rtt * 2
     *   JITTER_BUFFER = max_rtt - min_rtt
     *
     * Returns lead time clamped to [MIN_LEAD_TIME_MS, MAX_LEAD_TIME_MS].
     */
    getAdaptiveLeadTime() {
        if (this.samples.length === 0) {
            return BASE_LEAD_TIME_MS;
        }

        const rtts = this.samples.map(s => s.rtt);
        const minRtt = Math.min(...rtts);
        const maxRtt = Math.max(...rtts);

        // RTT buffer: 2x the best observed RTT
        const rttBuffer = minRtt * 2;

        // Jitter buffer: difference between max and min RTT
        const jitterBuffer = maxRtt - minRtt;

        // Compute adaptive lead time
        let adaptiveLeadTime = BASE_LEAD_TIME_MS + rttBuffer + jitterBuffer;

        // Clamp to valid range
        adaptiveLeadTime = Math.max(MIN_LEAD_TIME_MS, Math.min(MAX_LEAD_TIME_MS, adaptiveLeadTime));

        console.log(`[ClockSync] Adaptive lead time: ${Math.round(adaptiveLeadTime)}ms ` +
            `(base=${BASE_LEAD_TIME_MS}, rtt_buffer=${Math.round(rttBuffer)}, jitter=${Math.round(jitterBuffer)})`);

        return Math.round(adaptiveLeadTime);
    }
}

// Export for use in other modules
window.ClockSync = ClockSync;
