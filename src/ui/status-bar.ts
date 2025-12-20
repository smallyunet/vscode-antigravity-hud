import * as vscode from 'vscode';
import { QuotaResponse, ModelQuota, QuotaUpdateEvent } from '../types';
import { logger } from '../utils/logger';

/**
 * StatusBarManager - Manages the VS Code status bar item for quota display
 * 
 * Shows a minimal "AG: XX%" indicator that expands to full details on click.
 */
export class StatusBarManager {
    private statusBarItem: vscode.StatusBarItem;
    private currentQuota: QuotaResponse | null = null;
    private connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
    private lowQuotaThreshold: number;
    private enableNotifications: boolean;
    private hasNotifiedLowQuota: Set<string> = new Set();

    constructor(lowQuotaThreshold: number = 20, enableNotifications: boolean = true) {
        this.lowQuotaThreshold = lowQuotaThreshold;
        this.enableNotifications = enableNotifications;

        // Create status bar item on the right side, with moderate priority
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );

        this.statusBarItem.command = 'antigravity-hud.showQuota';
        this.updateDisplay();
        this.statusBarItem.show();

        logger.info(`StatusBarManager initialized (threshold: ${lowQuotaThreshold}%, notifications: ${enableNotifications})`);
    }

    /**
     * Update the status bar with new quota data
     */
    update(event: QuotaUpdateEvent): void {
        if (event.error) {
            this.connectionStatus = 'error';
            this.currentQuota = null;
            logger.debug('Status bar updated with error state');
        } else if (event.quota) {
            this.connectionStatus = 'connected';
            this.currentQuota = event.quota;
            this.checkLowQuota(event.quota);
            logger.debug('Status bar updated with new quota data');
        }
        this.updateDisplay();
    }

    /**
     * Set connection status
     */
    setConnectionStatus(status: 'disconnected' | 'connecting' | 'connected' | 'error'): void {
        this.connectionStatus = status;
        this.updateDisplay();
    }

    /**
     * Update the visual display of the status bar item
     */
    private updateDisplay(): void {
        const { text, tooltip, color, backgroundColor } = this.formatDisplay();
        this.statusBarItem.text = text;
        this.statusBarItem.tooltip = tooltip;
        this.statusBarItem.color = color;
        this.statusBarItem.backgroundColor = backgroundColor;
    }

    /**
     * Format the display text, tooltip, and color based on current state
     */
    private formatDisplay(): { text: string; tooltip: string | vscode.MarkdownString; color: string | vscode.ThemeColor | undefined; backgroundColor: vscode.ThemeColor | undefined } {
        switch (this.connectionStatus) {
            case 'disconnected':
                return {
                    text: '$(circle-slash) AG: --',
                    tooltip: 'Antigravity HUD: Not connected. Click to retry.',
                    color: undefined,
                    backgroundColor: undefined
                };

            case 'connecting':
                return {
                    text: '$(sync~spin) AG: ...',
                    tooltip: 'Antigravity HUD: Connecting...',
                    color: undefined,
                    backgroundColor: undefined
                };

            case 'error':
                return {
                    text: '$(warning) AG: ERR',
                    tooltip: 'Antigravity HUD: Connection error. Click for details.',
                    color: new vscode.ThemeColor('statusBarItem.errorForeground'),
                    backgroundColor: new vscode.ThemeColor('statusBarItem.errorBackground')
                };

            case 'connected':
                if (!this.currentQuota || this.currentQuota.models.length === 0) {
                    return {
                        text: '$(alert) AG: ???',
                        tooltip: 'Antigravity HUD: Connected (Data Unavailable)',
                        color: undefined,
                        backgroundColor: new vscode.ThemeColor('statusBarItem.warningBackground')
                    };
                }

                // Calculate overall percentage from primary model or average
                const percentage = this.calculateOverallPercentage();
                const color = this.getColorForPercentage(percentage);
                const backgroundColor = this.getBackgroundColorForPercentage(percentage);
                const icon = this.getIconForPercentage(percentage);

                return {
                    text: `${icon} AG: ${percentage}%`,
                    tooltip: this.formatTooltip(),
                    color,
                    backgroundColor
                };
        }
    }

    /**
     * Calculate overall quota percentage
     */
    private calculateOverallPercentage(): number {
        if (!this.currentQuota || this.currentQuota.models.length === 0) {
            return 0;
        }

        // Use minimum percentage across all models (most restrictive)
        const percentages = this.currentQuota.models.map(m =>
            m.limit > 0 ? Math.round((m.remaining / m.limit) * 100) : 0
        );

        return Math.min(...percentages);
    }

    /**
     * Get color based on percentage
     */
    private getColorForPercentage(percentage: number): string | vscode.ThemeColor | undefined {
        return undefined; // Keep text color default/white when using background colors for better contrast
    }

    /**
     * Get background color based on percentage
     */
    private getBackgroundColorForPercentage(percentage: number): vscode.ThemeColor | undefined {
        if (percentage <= 20) {
            return new vscode.ThemeColor('statusBarItem.errorBackground');
        } else if (percentage <= 50) {
            return new vscode.ThemeColor('statusBarItem.warningBackground');
        }
        return undefined;
    }

    /**
     * Get icon based on percentage
     */
    private getIconForPercentage(percentage: number): string {
        if (percentage <= 20) {
            return '$(warning)';
        } else if (percentage <= 50) {
            return '$(info)';
        }
        return '$(check)';
    }

    /**
     * Format detailed tooltip text using Markdown
     */
    private formatTooltip(): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.supportHtml = true;

        if (!this.currentQuota) {
            md.appendText('Antigravity HUD: No data');
            return md;
        }

        md.appendMarkdown('### Antigravity HUD Quotas\n\n');

        // Table Header
        md.appendMarkdown('| Model | Status | Remaining | Reset |\n');
        md.appendMarkdown('| :--- | :---: | :---: | :--- |\n');

        for (const model of this.currentQuota.models) {
            const percent = model.limit > 0
                ? Math.round((model.remaining / model.limit) * 100)
                : 0;

            let statusIcon = '🟢';
            if (percent <= 20) statusIcon = '🔴';
            else if (percent <= 50) statusIcon = '🟡';

            const remainingStr = `${model.remaining}/${model.limit} (${percent}%)`;
            const resetStr = model.resetAt ? this.formatResetTime(model.resetAt) : '-';

            md.appendMarkdown(`| **${model.modelName}** | ${statusIcon} | ${remainingStr} | ${resetStr} |\n`);
        }

        md.appendMarkdown('\n---\n');

        // Footer info
        const lowest = this.calculateOverallPercentage();
        md.appendMarkdown(`$(info) **Status Bar displays:** Lowest quota across all models (${lowest}%)\n\n`);
        md.appendMarkdown(`$(clock) **Last updated:** ${this.formatTime(this.currentQuota.lastUpdated)}`);

        return md;
    }

    /**
     * Format reset time relative to now
     */
    private formatResetTime(date: Date): string {
        const now = new Date();
        const diff = date.getTime() - now.getTime();

        if (diff <= 0) {
            return 'now';
        }

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        }
        return `${minutes}m`;
    }

    /**
     * Format time for display
     */
    private formatTime(date: Date): string {
        return date.toLocaleTimeString();
    }

    /**
     * Show detailed quota information in a QuickPick
     */
    async showQuotaDetails(): Promise<void> {
        if (!this.currentQuota || this.currentQuota.models.length === 0) {
            vscode.window.showInformationMessage(
                'Antigravity HUD: No quota data available. ' +
                (this.connectionStatus === 'disconnected'
                    ? 'Not connected to Antigravity process.'
                    : 'Waiting for data...')
            );
            return;
        }

        const items: vscode.QuickPickItem[] = this.currentQuota.models.map(model => ({
            label: `$(${this.getQuickPickIcon(model)}) ${model.modelName}`,
            description: `${model.remaining}/${model.limit}`,
            detail: this.getModelDetail(model)
        }));

        // Add separator and info items
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        items.push({
            label: '$(clock) Last Updated',
            description: this.formatTime(this.currentQuota.lastUpdated)
        });
        items.push({
            label: '$(refresh) Refresh Now',
            description: 'Fetch latest quota data'
        });

        const selected = await vscode.window.showQuickPick(items, {
            title: 'Antigravity HUD - Model Quotas',
            placeHolder: 'Select an item for more info'
        });

        if (selected?.label === '$(refresh) Refresh Now') {
            vscode.commands.executeCommand('antigravity-hud.refresh');
        }
    }

    /**
     * Get icon for QuickPick based on model quota
     */
    private getQuickPickIcon(model: ModelQuota): string {
        const percent = model.limit > 0
            ? Math.round((model.remaining / model.limit) * 100)
            : 0;

        if (percent <= 20) return 'error';
        if (percent <= 50) return 'warning';
        return 'pass';
    }

    /**
     * Get detail string for model in QuickPick
     */
    private getModelDetail(model: ModelQuota): string {
        const percent = model.limit > 0
            ? Math.round((model.remaining / model.limit) * 100)
            : 0;

        let detail = `${percent}% remaining`;
        if (model.resetAt) {
            detail += ` • Resets in ${this.formatResetTime(model.resetAt)}`;
        }
        return detail;
    }

    /**
     * Get current quota data
     */
    getCurrentQuota(): QuotaResponse | null {
        return this.currentQuota;
    }

    /**
     * Update configuration
     */
    updateConfig(lowQuotaThreshold: number, enableNotifications: boolean): void {
        this.lowQuotaThreshold = lowQuotaThreshold;
        this.enableNotifications = enableNotifications;

        // Reset notification state if threshold changes or notifications are re-enabled
        this.hasNotifiedLowQuota.clear();

        // Re-check quota with new settings
        if (this.currentQuota) {
            this.checkLowQuota(this.currentQuota);
        }

        this.updateDisplay();
        logger.info(`StatusBarManager config updated (threshold: ${lowQuotaThreshold}%, notifications: ${enableNotifications})`);
    }

    /**
     * Check for low quota and notify user
     */
    private checkLowQuota(quota: QuotaResponse): void {
        if (!this.enableNotifications) {
            return;
        }

        for (const model of quota.models) {
            if (model.limit <= 0) continue;

            const percentage = Math.round((model.remaining / model.limit) * 100);

            if (percentage <= this.lowQuotaThreshold) {
                // Only notify if we haven't already notified for this model at this session
                // We use a simple ID check. A more robust system might track if quota goes back UP.
                if (!this.hasNotifiedLowQuota.has(model.modelId)) {
                    vscode.window.showWarningMessage(
                        `Antigravity Warning: ${model.modelName} is low on quota (${percentage}% remaining).`,
                        'Show Details'
                    ).then(selection => {
                        if (selection === 'Show Details') {
                            this.showQuotaDetails();
                        }
                    });

                    this.hasNotifiedLowQuota.add(model.modelId);
                    logger.info(`Low quota notification sent for ${model.modelName} (${percentage}%)`);
                }
            } else {
                // If quota is back above threshold, reset notification state so we can notify again if it drops
                if (this.hasNotifiedLowQuota.has(model.modelId)) {
                    this.hasNotifiedLowQuota.delete(model.modelId);
                }
            }
        }
    }

    /**
     * Dispose of the status bar item
     */
    dispose(): void {
        this.statusBarItem.dispose();
        logger.info('StatusBarManager disposed');
    }
}
