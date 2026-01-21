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
        // Notifications disabled - never show popup warnings for quota
        return;
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
