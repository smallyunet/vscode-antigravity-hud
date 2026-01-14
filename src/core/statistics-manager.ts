import * as vscode from 'vscode';
import { QuotaResponse, ModelStatistics } from '../types';
import { logger } from '../utils/logger';

interface StoredModelStats {
    totalUsageTime: number; // seconds
    last100Time?: number; // timestamp
    history: { timestamp: number; percent: number }[];
    lastUpdateTimestamp: number;
}

export class StatisticsManager {
    private static readonly KEY_STATS = 'antigravity-hud.stats';
    private context: vscode.ExtensionContext;
    private stats: { [modelId: string]: StoredModelStats } = {};
    // Max history items to store (e.g. 1 sample per minute * 60 minutes = 1 hour history for speed calc)
    private static readonly MAX_HISTORY_ITEMS = 60;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.loadStats();
    }

    private loadStats() {
        this.stats = this.context.globalState.get(StatisticsManager.KEY_STATS, {});
        // Logging for debug
        logger.debug(`Loaded stats for ${Object.keys(this.stats).length} models`);
    }

    private saveStats() {
        this.context.globalState.update(StatisticsManager.KEY_STATS, this.stats);
    }

    /**
     * Update stats based on new quota data
     */
    processQuotaUpdate(quota: QuotaResponse | null) {
        if (!quota) return;

        const now = Date.now();
        let changed = false;

        for (const model of quota.models) {
            const modelId = model.modelId;
            let modelStats = this.stats[modelId];

            if (!modelStats) {
                modelStats = {
                    totalUsageTime: 0,
                    history: [],
                    lastUpdateTimestamp: now
                };
                this.stats[modelId] = modelStats;
            }

            // Calculate percentage
            const percent = model.limit > 0 ? (model.remaining / model.limit) * 100 : 0;

            // Update Total Usage Time
            // We only add time if the gap is reasonable (e.g. < 5 mins). 
            // This prevents counting time when VS Code was closed.
            const timeSinceLastUpdate = (now - modelStats.lastUpdateTimestamp) / 1000;
            if (timeSinceLastUpdate < 300 && timeSinceLastUpdate > 0) {
                modelStats.totalUsageTime += timeSinceLastUpdate;
            }

            // Update Last 100% Time
            // If currently near 100%, reset timestamp
            if (percent >= 99.9) {
                modelStats.last100Time = now;
            }

            // Update History (Circular Buffer)
            // Verify we don't have duplicate timestamps to avoid divide by zero later
            const lastHistory = modelStats.history[modelStats.history.length - 1];

            // Push if we have no history, or if it's been at least 1 minute since last snapshot
            if (!lastHistory || (now - lastHistory.timestamp) >= 60000) {
                modelStats.history.push({ timestamp: now, percent });
                if (modelStats.history.length > StatisticsManager.MAX_HISTORY_ITEMS) {
                    modelStats.history.shift();
                }
            }

            modelStats.lastUpdateTimestamp = now;
            changed = true;
        }

        if (changed) {
            this.saveStats();
        }
    }

    /**
     * Get calculated statistics for a model
     */
    getModelStats(modelId: string): ModelStatistics | null {
        const stored = this.stats[modelId];
        if (!stored) return null;

        const now = Date.now();

        // Calculate Speed (% per hour)
        let speed = 0;
        if (stored.history.length >= 2) {
            // Look at the window of history we have
            const start = stored.history[0];
            const end = stored.history[stored.history.length - 1];
            const timeDiffHours = (end.timestamp - start.timestamp) / (1000 * 3600);

            if (timeDiffHours > 0.05) { // Need at least ~3 mins of data
                const percentDiff = start.percent - end.percent;
                // Only count consumption (positive drop)
                if (percentDiff > 0) {
                    speed = percentDiff / timeDiffHours;
                }
            }
        }

        // Estimated Time Remaining
        // based on CURRENT percentage and speed
        const currentPercent = stored.history.length > 0 ? stored.history[stored.history.length - 1].percent : 0;
        let eta = undefined;
        if (speed > 0.1 && currentPercent > 0) {
            const remainingHours = currentPercent / speed;
            eta = remainingHours * 60; // minutes
        }

        // Usage Since Last 100
        let usageSinceLast100 = 0;
        if (stored.last100Time) {
            usageSinceLast100 = (now - stored.last100Time) / 1000;
        }

        return {
            totalUsageTime: stored.totalUsageTime,
            usageSinceLast100,
            last100Time: stored.last100Time,
            consumptionSpeed: speed,
            estimatedTimeRemaining: eta
        };
    }
}
