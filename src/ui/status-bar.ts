import * as vscode from 'vscode';
import { QuotaResponse, QuotaUpdateEvent } from '../types';
import { logger } from '../utils/logger';
import { StatisticsManager } from '../core/statistics-manager';
import { formatPercentage, formatPercentageDisplay, formatQuotaText, formatTime, formatResetTime, formatAbsoluteTime, getIconForPercentage, getColorForPercentage, getBackgroundColorForPercentage, formatDuration } from './formatters';
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
                const overallPercentage = this.calculateOverallPercentage();
                const color = getColorForPercentage(overallPercentage);
                const backgroundColor = getBackgroundColorForPercentage(overallPercentage);
                const icon = getIconForPercentage(overallPercentage);

                // Use the primary model for more descriptive text if possible
                let displayPercent = `${overallPercentage}%`;
                const activeModelId = this.statsManager.getMostRecentlyConsumedModelId() || this.selectedModelId;
                if (activeModelId) {
                    const model = this.currentQuota.models.find(m => m.modelId === activeModelId);
                    if (model) {
                        displayPercent = formatPercentageDisplay(model);
                    }
                } else if (this.currentQuota.models.length > 0) {
                    // Use formatPercentageDisplay on the lowest to handle buckets
                    const lowestModel = this.currentQuota.models.reduce((prev, curr) =>
                        formatPercentage(curr) < formatPercentage(prev) ? curr : prev
                    );
                    displayPercent = formatPercentageDisplay(lowestModel);
                }

                return {
                    text: `${icon} AG: ${displayPercent}`,
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

        // 1. If a model is manually selected, use that
        if (this.selectedModelId) {
            const selectedModel = this.currentQuota.models.find(m => m.modelId === this.selectedModelId);
            if (selectedModel) {
                return formatPercentage(selectedModel);
            }
        }

        // 2. Try to find the most recently used model
        const activeModelId = this.statsManager.getMostRecentlyConsumedModelId();
        if (activeModelId) {
            const activeModel = this.currentQuota.models.find(m => m.modelId === activeModelId);
            if (activeModel) {
                return formatPercentage(activeModel);
            }
        }

        // 3. Fallback: Use minimum percentage across all models (most restrictive)
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

        // Header with User Tier
        if (this.currentQuota.userTier) {
            md.appendMarkdown(`### Antigravity HUD (${this.currentQuota.userTier})\n\n`);
        } else {
            md.appendMarkdown('### Antigravity HUD\n\n');
        }

        // Table Header
        md.appendMarkdown('| Model | Status | Quota | Reset |\n');
        md.appendMarkdown('| :--- | :---: | :---: | :--- |\n');

        // Sort models: Recommended First -> High Quota -> Low Quota -> Name
        const sortedModels = [...this.currentQuota.models].sort((a, b) => {
            // 1. Recommended first
            if (a.isRecommended && !b.isRecommended) return -1;
            if (!a.isRecommended && b.isRecommended) return 1;

            // 2. Sort by Quota (Ascending)
            const pctA = formatPercentage(a);
            const pctB = formatPercentage(b);
            if (pctA !== pctB) return pctA - pctB;

            // 3. Sort by Name
            return a.modelName.localeCompare(b.modelName);
        });

        for (const model of sortedModels) {
            const percent = formatPercentage(model);

            let statusIcon = '🟢';
            if (percent <= 20) statusIcon = '🔴';
            else if (percent <= 50) statusIcon = '🟡';

            // Mark recommended models
            let displayModelName = model.modelName;
            if (model.isRecommended) {
                displayModelName = `★ ${displayModelName}`;
            }

            const remainingStr = formatQuotaText(model);

            // Show Absolute Time (e.g. "18:15") and relative in parens if space allows, 
            // but table cells wrap, so let's stick to Absolute + Relative tooltip? 
            // Better: "18:15" with Relative in tooltip, or just "18:15" 
            let resetStr = '-';
            if (model.resetAt) {
                resetStr = formatAbsoluteTime(model.resetAt); // "18:15"
                // Add relative time as part of the cell if expected to fit, or simple string concatenation
                // md does not support cell tooltips easily.
                resetStr += ` (${formatResetTime(model.resetAt)})`;
            }

            // Status icon in middle column
            md.appendMarkdown(`| **${displayModelName}** | ${statusIcon} | ${remainingStr} | ${resetStr} |\n`);
        }

        md.appendMarkdown('\n---\n');

        // Footer info
        const lowestModel = this.currentQuota.models.reduce((prev, curr) =>
            formatPercentage(curr) < formatPercentage(prev) ? curr : prev
        );
        let targetModel: import('../types').ModelQuota | undefined;

        if (this.selectedModelId) {
            targetModel = this.currentQuota.models.find(m => m.modelId === this.selectedModelId);
            if (targetModel) {
                md.appendMarkdown(`$(verified) **Monitored Model:** ${targetModel.modelName} (${formatPercentageDisplay(targetModel)})\n\n`);
            }
        } else {
            // Check for active model
            const activeModelId = this.statsManager.getMostRecentlyConsumedModelId();
            if (activeModelId) {
                targetModel = this.currentQuota.models.find(m => m.modelId === activeModelId);
            }

            if (targetModel) {
                md.appendMarkdown(`$(zap) **Active Model:** ${targetModel.modelName} (${formatPercentageDisplay(targetModel)})\n\n`);
            } else {
                // Fallback to lowest
                md.appendMarkdown(`$(info) **Status Bar displays:** Lowest quota across all models (${formatPercentageDisplay(lowestModel)})\n\n`);
                targetModel = lowestModel;
            }
        }

        // Add stats for target model
        if (targetModel) {
            const stats = this.statsManager.getModelStats(targetModel.modelId);
            if (stats && (stats.consumptionSpeed > 0 || stats.estimatedTimeRemaining)) {

                const speed = Math.round(stats.consumptionSpeed);
                let speedStr = '';
                let etaStr = '';

                if (stats.consumptionSpeed > 0) {
                    speedStr = `$(dashboard) **Speed:** ~${speed}%/h`;
                }

                if (stats.estimatedTimeRemaining) {
                    // Convert minutes to seconds for formatDuration
                    const durationStr = formatDuration(stats.estimatedTimeRemaining * 60);
                    etaStr = `$(history) **Remaining:** ~${durationStr}`;
                }

                const separator = (speedStr && etaStr) ? ' • ' : '';
                md.appendMarkdown(`${speedStr}${separator}${etaStr}\n\n`);
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
