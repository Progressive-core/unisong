/**
 * Sync Diagnostics Module
 *
 * Read-only metrics for observing synchronization quality.
 * Does NOT affect playback behavior.
 */

class SyncDiagnostics {
    constructor() {
        // Playback delay metrics
        this.playbackDelays = [];
        this.negativeDelayCount = 0;

        // RTT metrics (populated from ClockSync)
        this.rttSamples = [];
    }

    /**
     * Record a playback delay measurement.
     * Called when scheduling playback.
     */
    recordPlaybackDelay(rawDelayMs, clampedDelayMs) {
        const record = {
            timestamp: Date.now(),
            rawDelay: rawDelayMs,
            clampedDelay: clampedDelayMs,
            wasNegative: rawDelayMs < 0,
        };

        this.playbackDelays.push(record);

        if (rawDelayMs < 0) {
            this.negativeDelayCount++;
        }

        console.log(`[SyncDiagnostics] Playback delay: raw=${rawDelayMs}ms, clamped=${clampedDelayMs}ms` +
            (rawDelayMs < 0 ? ' (NEGATIVE)' : ''));
    }

    /**
     * Record RTT samples from clock sync.
     */
    recordRttSamples(samples) {
        this.rttSamples = samples.map(s => s.rtt);
        this.logRttStats();
    }

    /**
     * Get RTT distribution statistics.
     */
    getRttStats() {
        if (this.rttSamples.length === 0) {
            return null;
        }

        const sorted = [...this.rttSamples].sort((a, b) => a - b);
        const sum = sorted.reduce((a, b) => a + b, 0);

        return {
            count: sorted.length,
            min: sorted[0],
            max: sorted[sorted.length - 1],
            avg: sum / sorted.length,
            samples: sorted,
        };
    }

    /**
     * Log RTT statistics to console.
     */
    logRttStats() {
        const stats = this.getRttStats();
        if (!stats) {
            console.log('[SyncDiagnostics] No RTT samples recorded');
            return;
        }

        console.log(`[SyncDiagnostics] RTT distribution: ` +
            `min=${stats.min}ms, max=${stats.max}ms, avg=${stats.avg.toFixed(1)}ms ` +
            `(${stats.count} samples)`);
    }

    /**
     * Get playback delay statistics.
     */
    getDelayStats() {
        if (this.playbackDelays.length === 0) {
            return null;
        }

        const rawDelays = this.playbackDelays.map(d => d.rawDelay);
        const sum = rawDelays.reduce((a, b) => a + b, 0);

        return {
            count: this.playbackDelays.length,
            negativeCount: this.negativeDelayCount,
            avgRawDelay: sum / rawDelays.length,
            records: this.playbackDelays,
        };
    }

    /**
     * Get full diagnostics summary.
     */
    getSummary() {
        return {
            rtt: this.getRttStats(),
            delay: this.getDelayStats(),
        };
    }

    /**
     * Log full diagnostics summary to console.
     */
    logSummary() {
        console.log('[SyncDiagnostics] === DIAGNOSTICS SUMMARY ===');

        const rtt = this.getRttStats();
        if (rtt) {
            console.log(`  RTT: min=${rtt.min}ms, max=${rtt.max}ms, avg=${rtt.avg.toFixed(1)}ms`);
        }

        const delay = this.getDelayStats();
        if (delay) {
            console.log(`  Playback delays: ${delay.count} scheduled, ${delay.negativeCount} negative`);
            if (delay.count > 0) {
                console.log(`  Avg raw delay: ${delay.avgRawDelay.toFixed(1)}ms`);
            }
        }

        console.log('[SyncDiagnostics] ===========================');
    }

    /**
     * Reset all metrics.
     */
    reset() {
        this.playbackDelays = [];
        this.negativeDelayCount = 0;
        this.rttSamples = [];
    }
}

// Global diagnostics instance
window.SyncDiagnostics = SyncDiagnostics;
window.syncDiagnostics = new SyncDiagnostics();
