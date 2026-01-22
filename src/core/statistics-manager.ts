import * as vscode from 'vscode';
import { QuotaResponse, ModelStatistics } from '../types';
import { logger } from '../utils/logger';

interface StoredModelStats {
    totalUsageTime: number; // seconds
    last100Time?: number; // timestamp
    history: { timestamp: number; percent: number }[];
    lastUpdateTimestamp: number;
    lastConsumptionTime?: number;
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

            // Track consumption (if percent dropped)
            // Check previous percent from history or last update
            const lastPercent = modelStats.history.length > 0
                ? modelStats.history[modelStats.history.length - 1].percent
                : percent;

            // If percent dropped (and reasonable drop, not a reset from 0 to 100)
            if (percent < lastPercent && (lastPercent - percent) < 50) {
                modelStats.lastConsumptionTime = now;
            }

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
     * Get the model ID that was most recently consumed
     */
    getMostRecentlyConsumedModelId(): string | null {
        let lastTime = 0;
        let modelId = null;

        for (const [id, stat] of Object.entries(this.stats)) {
            if (stat.lastConsumptionTime && stat.lastConsumptionTime > lastTime) {
                lastTime = stat.lastConsumptionTime;
                modelId = id;
            }
        }
        return modelId;
    }

    /**
     * Get calculated statistics for a model
     */
    getModelStats(modelId: string, isLikelyBucketed: boolean = false): ModelStatistics | null {
        const stored = this.stats[modelId];
        if (!stored) return null;

        const now = Date.now();

        let speed = 0;

        if (isLikelyBucketed) {
            speed = this.calculateBucketedSpeed(stored.history);
        } else {
            speed = this.calculateContinuousSpeed(stored.history);
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

    private calculateContinuousSpeed(history: { timestamp: number; percent: number }[]): number {
        if (history.length < 2) {
            return 0;
        } else {
            // proceed
        }

        const start = history[0];
        const end = history[history.length - 1];
        const timeDiffHours = (end.timestamp - start.timestamp) / (1000 * 3600);

        if (timeDiffHours <= 0.05) {
            return 0;
        } else {
            // proceed
        }

        const percentDiff = start.percent - end.percent;
        if (percentDiff <= 0) {
            return 0;
        } else {
            return percentDiff / timeDiffHours;
        }
    }

    private calculateBucketedSpeed(history: { timestamp: number; percent: number }[]): number {
        if (history.length < 2) {
            return 0;
        } else {
            // proceed
        }

        const dropEvents: { timestamp: number; delta: number }[] = [];

        for (let i = 1; i < history.length; i++) {
            const prev = history[i - 1];
            const curr = history[i];
            const delta = prev.percent - curr.percent;

            if (delta > 0.1 && delta < 50) {
                dropEvents.push({ timestamp: curr.timestamp, delta });
            } else {
                // ignore (no change or reset)
            }
        }

        // Prefer multiple drop events for stability.
        if (dropEvents.length >= 2) {
            const first = dropEvents[0];
            const last = dropEvents[dropEvents.length - 1];

            const timeDiffHours = (last.timestamp - first.timestamp) / (1000 * 3600);
            if (timeDiffHours <= 0.05) {
                return 0;
            } else {
                // proceed
            }

            const totalDrop = dropEvents.reduce((sum, e) => sum + e.delta, 0);
            if (totalDrop <= 0) {
                return 0;
            } else {
                return totalDrop / timeDiffHours;
            }
        } else {
            // Fallback: use the entire observation window, but require a minimum time window
            const start = history[0];
            const end = history[history.length - 1];
            const timeDiffHours = (end.timestamp - start.timestamp) / (1000 * 3600);
            const percentDiff = start.percent - end.percent;

            // Need at least ~15 minutes and at least one bucket drop to show a speed.
            if (timeDiffHours < 0.25) {
                return 0;
            } else if (percentDiff < 15) {
                return 0;
            } else {
                return percentDiff / timeDiffHours;
            }
        }
    }
}
