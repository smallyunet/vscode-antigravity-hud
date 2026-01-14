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
        }

        // Group models by percentage
        const modelsByPercentage = new Map<number, import('../types').ModelQuota[]>();

        for (const model of quota.models) {
            if (model.limit <= 0) continue;

            const percentage = Math.round((model.remaining / model.limit) * 100);

            if (percentage <= this.lowQuotaThreshold) {
                if (!this.hasNotifiedLowQuota.has(model.modelId)) {
                    const group = modelsByPercentage.get(percentage) || [];
                    group.push(model);
                    modelsByPercentage.set(percentage, group);
                }
            }
        }

        // Send notifications for each group
        for (const [percentage, models] of modelsByPercentage) {
            const modelNames = models.map(m => m.modelName).join(', ');
            const isPlural = models.length > 1;
            const message = `Antigravity Warning: ${modelNames} ${isPlural ? 'are' : 'is'} low on quota (${percentage}% remaining).`;

            vscode.window.showWarningMessage(
                message,
                'Show Details'
            ).then(selection => {
                if (selection === 'Show Details') {
                    this.showDetailsCallback();
                }
            });

            // Mark all as notified
            for (const model of models) {
                this.hasNotifiedLowQuota.add(model.modelId);
                logger.info(`Low quota notification sent for ${model.modelName} (${percentage}%)`);
            }
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
