import * as vscode from 'vscode';
import { QuotaResponse, QuotaUpdateEvent } from '../types';
import { logger } from '../utils/logger';
import { StatisticsManager } from '../core/statistics-manager';
import { formatPercentage, formatTime, formatResetTime, getIconForPercentage, getColorForPercentage, getBackgroundColorForPercentage } from './formatters';
import { NotificationManager } from './notification-manager';
import { MenuManager } from './menu-manager';

/**
 * StatusBarManager - Manages the VS Code status bar item for quota display
 * 
 * Shows a minimal "AG: XX%" indicator that expands to full details on click.
 */
export class StatusBarManager {
    private statusBarItem: vscode.StatusBarItem;
    private currentQuota: QuotaResponse | null = null;
    private connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
    private context: vscode.ExtensionContext;
    private selectedModelId: string | null = null;
    private static readonly KEY_SELECTED_MODEL = 'antigravity-hud.selectedModelId';

    // Components
    private notificationManager: NotificationManager;
    private menuManager: MenuManager;
    private statsManager: StatisticsManager;

    constructor(
        context: vscode.ExtensionContext,
        statsManager: StatisticsManager,
        lowQuotaThreshold: number = 20,
        enableNotifications: boolean = true
    ) {
        this.context = context;
        this.statsManager = statsManager;

        // Restore selected model
        this.selectedModelId = this.context.globalState.get<string | null>(StatusBarManager.KEY_SELECTED_MODEL, null);

        // Initialize sub-managers
        this.notificationManager = new NotificationManager(
            lowQuotaThreshold,
            enableNotifications,
            () => this.showQuotaDetails()
        );

        this.menuManager = new MenuManager(
            statsManager,
            (id) => this.setModelSelection(id)
        );

        // Create status bar item
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.statusBarItem.command = 'antigravity-hud.showQuota';

        this.updateDisplay();
        this.statusBarItem.show();

        logger.info(`StatusBarManager initialized`);
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
            this.notificationManager.checkLowQuota(event.quota);
            logger.debug('Status bar updated with new quota data');
        }
        this.updateDisplay();
    }

    /**
     * Show detailed quota information
     */
    async showQuotaDetails(): Promise<void> {
        await this.menuManager.showQuotaDetails(
            this.currentQuota,
            this.connectionStatus,
            this.selectedModelId
        );
    }

    /**
     * Show model selection directly
     */
    async selectModel(): Promise<void> {
        if (this.currentQuota) {
            await this.menuManager.selectModel(this.currentQuota, this.selectedModelId);
        }
    }

    /**
     * Set the selected model ID (callback from MenuManager)
     */
    private async setModelSelection(modelId: string | null): Promise<void> {
        this.selectedModelId = modelId;
        await this.context.globalState.update(StatusBarManager.KEY_SELECTED_MODEL, this.selectedModelId);
        this.updateDisplay();
    }

    /**
     * Update configuration
     */
    updateConfig(lowQuotaThreshold: number, enableNotifications: boolean): void {
        this.notificationManager.updateConfig(lowQuotaThreshold, enableNotifications);

        // Re-check quota with new settings
        if (this.currentQuota) {
            this.notificationManager.recheck(this.currentQuota);
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
                const color = getColorForPercentage(percentage);
                const backgroundColor = getBackgroundColorForPercentage(percentage);
                const icon = getIconForPercentage(percentage);

                return {
                    text: `${icon} AG: ${percentage}%`,
                    tooltip: this.formatTooltip(),
                    color,
                    backgroundColor
                };
        }
    }

    /**
     * Calculate overall percentage
     */
    private calculateOverallPercentage(): number {
        if (!this.currentQuota || this.currentQuota.models.length === 0) {
            return 0;
        }

        // If a model is selected, use that
        if (this.selectedModelId) {
            const selectedModel = this.currentQuota.models.find(m => m.modelId === this.selectedModelId);
            if (selectedModel) {
                return formatPercentage(selectedModel);
            }
        }

        // Use minimum percentage across all models (most restrictive)
        const percentages = this.currentQuota.models.map(m => formatPercentage(m));

        return Math.min(...percentages);
    }

    /**
     * Format detailed tooltip text using Markdown
     */
    private formatTooltip(): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.supportThemeIcons = true;
        md.supportHtml = true;

        if (!this.currentQuota) {
            md.appendText('Antigravity HUD: No data');
            return md;
        }

        md.appendMarkdown('### Antigravity HUD Quotas\n\n');

        // Table Header
        md.appendMarkdown('| Model | Status | Remaining | Reset |\n');
        md.appendMarkdown('| :--- | :---: | :---: | :--- |\n');

        // Sort models by name for consistent display
        const sortedModels = [...this.currentQuota.models].sort((a, b) =>
            a.modelName.localeCompare(b.modelName)
        );

        for (const model of sortedModels) {
            const percent = formatPercentage(model);

            let statusIcon = '🟢';
            if (percent <= 20) statusIcon = '🔴';
            else if (percent <= 50) statusIcon = '🟡';

            const remainingStr = model.isFractional
                ? `${percent}%`
                : `${model.remaining}/${model.limit} (${percent}%)`;

            const resetStr = model.resetAt ? formatResetTime(model.resetAt) : '-';

            md.appendMarkdown(`| **${model.modelName}** | ${statusIcon} | ${remainingStr} | ${resetStr} |\n`);
        }

        md.appendMarkdown('\n---\n');

        // Footer info
        const lowest = this.calculateOverallPercentage();
        let targetModel: import('../types').ModelQuota | undefined;

        if (this.selectedModelId) {
            targetModel = this.currentQuota.models.find(m => m.modelId === this.selectedModelId);
            if (targetModel) {
                md.appendMarkdown(`$(verified) **Monitored Model:** ${targetModel.modelName} (${formatPercentage(targetModel)}%)\n\n`);
            }
        } else {
            md.appendMarkdown(`$(info) **Status Bar displays:** Lowest quota across all models (${lowest}%)\n\n`);
            // Find the model with lowest quota to show stats for
            targetModel = this.currentQuota.models.reduce((prev, curr) =>
                formatPercentage(curr) < formatPercentage(prev) ? curr : prev
            );
        }

        // Add stats for target model
        if (targetModel) {
            const stats = this.statsManager.getModelStats(targetModel.modelId);
            if (stats && (stats.consumptionSpeed > 0 || stats.estimatedTimeRemaining)) {
                md.appendMarkdown(`**Statistics (${targetModel.modelName}):**\n`);

                if (stats.consumptionSpeed > 0) {
                    md.appendMarkdown(`- Consumption Speed: ~${stats.consumptionSpeed.toFixed(1)}% / hour\n`);
                }

                if (stats.estimatedTimeRemaining) {
                    const h = Math.floor(stats.estimatedTimeRemaining / 60);
                    const m = Math.floor(stats.estimatedTimeRemaining % 60);
                    md.appendMarkdown(`- Est. Time Remaining: ~${h}h ${m}m\n`);
                }
                md.appendMarkdown('\n');
            }
        }

        md.appendMarkdown(`$(clock) **Last updated:** ${formatTime(this.currentQuota.lastUpdated)}`);

        return md;
    }

    /**
     * Dispose of the status bar item
     */
    dispose(): void {
        this.statusBarItem.dispose();
        logger.info('StatusBarManager disposed');
    }
}
