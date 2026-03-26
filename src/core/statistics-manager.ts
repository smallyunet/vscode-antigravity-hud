import * as vscode from 'vscode';
import { QuotaResponse, ModelStatistics } from '../types';
import { logger } from '../utils/logger';

interface StoredModelStats {
    totalUsageTime: number; // seconds
    last100Time?: number; // timestamp
    lastUpdateTimestamp: number;
}

export class StatisticsManager {
    private static readonly KEY_STATS = 'antigravity-hud.stats';
    private context: vscode.ExtensionContext;
    private stats: { [modelId: string]: StoredModelStats } = {};
    private saveTimer: NodeJS.Timeout | null = null;
    private savePending: boolean = false;
    private static readonly SAVE_DEBOUNCE_MS = 5000;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.loadStats();
    }

    private loadStats() {
        this.stats = this.context.globalState.get(StatisticsManager.KEY_STATS, {});
        // Logging for debug
        logger.debug(`Loaded stats for ${Object.keys(this.stats).length} models`);
    }

    private scheduleSave(): void {
        this.savePending = true;

        if (this.saveTimer) {
            return;
        }

        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.flushSave();
        }, StatisticsManager.SAVE_DEBOUNCE_MS);
    }

    private flushSave(): void {
        if (!this.savePending) {
            return;
        }

        this.savePending = false;
        void this.context.globalState.update(StatisticsManager.KEY_STATS, this.stats);
    }

    /**
     * Update stats based on new quota data
     */
    processQuotaUpdate(quota: QuotaResponse | null) {
        if (!quota) {
            return;
        }

        const now = Date.now();
        let changed = false;

        for (const model of quota.models) {
            const modelId = model.modelId;
            let modelStats = this.stats[modelId];

            let modelChanged = false;

            if (!modelStats) {
                modelStats = {
                    totalUsageTime: 0,
                    lastUpdateTimestamp: now
                };
                this.stats[modelId] = modelStats;
                modelChanged = true;
            }

            // Calculate percentage
            const percent = model.limit > 0 ? (model.remaining / model.limit) * 100 : 0;

            // Update Total Usage Time
            // We only add time if the gap is reasonable (e.g. < 5 mins). 
            // This prevents counting time when VS Code was closed.
            const timeSinceLastUpdate = (now - modelStats.lastUpdateTimestamp) / 1000;
            if (timeSinceLastUpdate < 300 && timeSinceLastUpdate > 0) {
                modelStats.totalUsageTime += timeSinceLastUpdate;
                modelChanged = true;
            }

            // Update Last 100% Time
            // If currently near 100%, reset timestamp
            if (percent >= 99.9) {
                if (modelStats.last100Time !== now) {
                    modelStats.last100Time = now;
                    modelChanged = true;
                }
            }

            modelStats.lastUpdateTimestamp = now;

            if (modelChanged) {
                changed = true;
            }
        }

        if (changed) {
            this.scheduleSave();
        }
    }

    /**
     * Clear all stored statistics.
     */
    async reset(): Promise<void> {
        this.stats = {};

        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }

        this.savePending = false;
        await this.context.globalState.update(StatisticsManager.KEY_STATS, this.stats);
    }

    /**
     * Flush pending saves and stop timers.
     */
    dispose(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }

        this.flushSave();
    }

    /**
     * Get calculated statistics for a model
     */
    getModelStats(modelId: string, isLikelyBucketed: boolean = false): ModelStatistics | null {
        const stored = this.stats[modelId];
        if (!stored) return null;

        const now = Date.now();

        // Usage Since Last 100
        let usageSinceLast100 = 0;
        if (stored.last100Time) {
            usageSinceLast100 = (now - stored.last100Time) / 1000;
        }

        return {
            totalUsageTime: stored.totalUsageTime,
            usageSinceLast100,
            last100Time: stored.last100Time
        };
    }


}
