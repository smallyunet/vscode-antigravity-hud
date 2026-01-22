import * as vscode from 'vscode';
import { QuotaResponse } from '../types';
import { logger } from '../utils/logger';

export class NotificationManager {
    private lowQuotaThreshold: number;
    private enableNotifications: boolean;
    private hasNotifiedLowQuota: Set<string> = new Set();
    private showDetailsCallback: () => void;

    constructor(
        lowQuotaThreshold: number,
        enableNotifications: boolean,
        showDetailsCallback: () => void
    ) {
        this.lowQuotaThreshold = lowQuotaThreshold;
        this.enableNotifications = enableNotifications;
        this.showDetailsCallback = showDetailsCallback;
    }

    /**
     * Update configuration
     */
    updateConfig(lowQuotaThreshold: number, enableNotifications: boolean): void {
        this.lowQuotaThreshold = lowQuotaThreshold;
        this.enableNotifications = enableNotifications;

        // Reset notification state if threshold changes or notifications are re-enabled
        this.hasNotifiedLowQuota.clear();
        logger.info(`NotificationManager config updated (threshold: ${lowQuotaThreshold}%, notifications: ${enableNotifications})`);
    }

    /**
     * Check for low quota and notify user
     */
    checkLowQuota(quota: QuotaResponse): void {
        if (!this.enableNotifications) {
            return;
        } else {
            // proceed
        }

        if (!quota || quota.models.length === 0) {
            return;
        } else {
            // proceed
        }

        // Hysteresis prevents spam when a quota hovers around the threshold.
        const clearThreshold = Math.min(100, this.lowQuotaThreshold + 5);

        for (const model of quota.models) {
            const percent = model.limit > 0 ? Math.round((model.remaining / model.limit) * 100) : 0;

            if (percent >= clearThreshold) {
                this.hasNotifiedLowQuota.delete(model.modelId);
                continue;
            } else {
                // proceed
            }

            const isLow = percent <= this.lowQuotaThreshold;
            if (!isLow) {
                continue;
            } else {
                // proceed
            }

            const hasNotified = this.hasNotifiedLowQuota.has(model.modelId);
            if (hasNotified) {
                continue;
            } else {
                // proceed
            }

            this.hasNotifiedLowQuota.add(model.modelId);

            const message = `Antigravity HUD: ${model.modelName} quota low (${percent}%).`;
            vscode.window.showWarningMessage(message, 'Show Details').then(selection => {
                if (selection === 'Show Details') {
                    this.showDetailsCallback();
                } else {
                    // no-op
                }
            });

            logger.info(`Low quota notification shown for ${model.modelName} (${percent}%)`);
        }
    }

    /**
     * Re-check current quota (e.g. after config change)
     */
    recheck(quota: QuotaResponse | null): void {
        if (quota) {
            this.checkLowQuota(quota);
        }
    }
}
