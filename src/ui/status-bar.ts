import * as vscode from 'vscode';
import { QuotaResponse, QuotaUpdateEvent } from '../types';
import { logger } from '../utils/logger';
import { StatisticsManager } from '../core/statistics-manager';
import { formatPercentage, formatPercentageDisplay, formatQuotaText, formatTime, formatResetTime, formatAbsoluteTime, getIconForPercentage, getColorForPercentage, getBackgroundColorForPercentage, formatDuration, getBatteryBar } from './formatters';
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

    private lastErrorMessage: string | null = null;
    private lastStatusMessage: string | null = null;
    private tooltipStatusStyle: 'battery' | 'traffic' = 'battery';

    // Components
    private notificationManager: NotificationManager;
    private menuManager: MenuManager;
    private statsManager: StatisticsManager;

    constructor(
        context: vscode.ExtensionContext,
        statsManager: StatisticsManager,
        lowQuotaThreshold: number = 20,
        enableNotifications: boolean = false,
        tooltipStatusStyle: 'battery' | 'traffic' = 'battery'
    ) {
        this.context = context;
        this.statsManager = statsManager;
        this.tooltipStatusStyle = tooltipStatusStyle;

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
            (id) => this.setModelSelection(id),
            () => { void this.clearMonitoredModel(); },
            () => { void this.resetStatistics(); }
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
            this.lastErrorMessage = event.error.message;
            this.lastStatusMessage = null;
            logger.debug('Status bar updated with error state');
        } else if (event.quota) {
            this.connectionStatus = 'connected';
            this.currentQuota = event.quota;
            this.lastErrorMessage = null;
            this.lastStatusMessage = null;
            this.notificationManager.checkLowQuota(event.quota);
            logger.debug('Status bar updated with new quota data');
        }
        this.updateDisplay();
    }

    async clearMonitoredModel(): Promise<void> {
        await this.setModelSelection(null);
        vscode.window.showInformationMessage('Antigravity HUD: Monitored model cleared (Auto).');
    }

    async resetStatistics(): Promise<void> {
        await this.statsManager.reset();
        this.updateDisplay();
        vscode.window.showInformationMessage('Antigravity HUD: Statistics reset.');
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
    updateConfig(lowQuotaThreshold: number, enableNotifications: boolean): void;
    updateConfig(lowQuotaThreshold: number, enableNotifications: boolean, tooltipStatusStyle: 'battery' | 'traffic'): void;
    updateConfig(lowQuotaThreshold: number, enableNotifications: boolean, tooltipStatusStyle?: 'battery' | 'traffic'): void {
        this.notificationManager.updateConfig(lowQuotaThreshold, enableNotifications);

        if (tooltipStatusStyle) {
            this.tooltipStatusStyle = tooltipStatusStyle;
        } else {
            // keep current
        }

        if (this.currentQuota) {
            this.notificationManager.recheck(this.currentQuota);
        } else {
            // no-op
        }

        this.updateDisplay();
    }

    /**
     * Set connection status
     */
    setConnectionStatus(status: 'disconnected' | 'connecting' | 'connected' | 'error', message?: string): void {
        this.connectionStatus = status;

        if (status === 'error') {
            this.lastErrorMessage = message || this.lastErrorMessage;
            this.lastStatusMessage = null;
        } else {
            this.lastStatusMessage = message || null;
        }

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
                return this.formatDisconnectedDisplay();

            case 'connecting':
                return this.formatConnectingDisplay();

            case 'error':
                return this.formatErrorDisplay();

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
                if (this.selectedModelId) {
                    const model = this.currentQuota.models.find(m => m.modelId === this.selectedModelId);
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
                    tooltip: this.formatTooltip(this.connectionStatus),
                    color,
                    backgroundColor
                };
        }
    }

    private formatDisconnectedDisplay(): { text: string; tooltip: string | vscode.MarkdownString; color: string | vscode.ThemeColor | undefined; backgroundColor: vscode.ThemeColor | undefined } {
        if (this.currentQuota && this.currentQuota.models.length > 0) {
            const overallPercentage = this.calculateOverallPercentage();
            const displayPercent = this.getDisplayPercent(overallPercentage);
            return {
                text: `$(circle-slash) AG: ${displayPercent}`,
                tooltip: this.formatTooltip('disconnected'),
                color: undefined,
                backgroundColor: undefined
            };
        } else {
            return {
                text: '$(circle-slash) AG: --',
                tooltip: 'Antigravity HUD: Not connected. Click to retry.',
                color: undefined,
                backgroundColor: undefined
            };
        }
    }

    private formatConnectingDisplay(): { text: string; tooltip: string | vscode.MarkdownString; color: string | vscode.ThemeColor | undefined; backgroundColor: vscode.ThemeColor | undefined } {
        if (this.currentQuota && this.currentQuota.models.length > 0) {
            const overallPercentage = this.calculateOverallPercentage();
            const displayPercent = this.getDisplayPercent(overallPercentage);
            return {
                text: `$(sync~spin) AG: ${displayPercent}`,
                tooltip: this.formatTooltip('connecting'),
                color: undefined,
                backgroundColor: undefined
            };
        } else {
            return {
                text: '$(sync~spin) AG: ...',
                tooltip: 'Antigravity HUD: Connecting...',
                color: undefined,
                backgroundColor: undefined
            };
        }
    }

    private formatErrorDisplay(): { text: string; tooltip: string | vscode.MarkdownString; color: string | vscode.ThemeColor | undefined; backgroundColor: vscode.ThemeColor | undefined } {
        if (this.currentQuota && this.currentQuota.models.length > 0) {
            const overallPercentage = this.calculateOverallPercentage();
            const displayPercent = this.getDisplayPercent(overallPercentage);

            return {
                text: `$(warning) AG: ${displayPercent}`,
                tooltip: this.formatTooltip('error'),
                color: new vscode.ThemeColor('statusBarItem.errorForeground'),
                backgroundColor: new vscode.ThemeColor('statusBarItem.errorBackground')
            };
        } else {
            return {
                text: '$(warning) AG: ERR',
                tooltip: 'Antigravity HUD: Connection error. Click for details.',
                color: new vscode.ThemeColor('statusBarItem.errorForeground'),
                backgroundColor: new vscode.ThemeColor('statusBarItem.errorBackground')
            };
        }
    }

    private getDisplayPercent(overallPercentage: number): string {
        let displayPercent = `${overallPercentage}%`;

        if (!this.currentQuota || this.currentQuota.models.length === 0) {
            return displayPercent;
        }

        if (this.selectedModelId) {
            const model = this.currentQuota.models.find(m => m.modelId === this.selectedModelId);
            if (model) {
                displayPercent = formatPercentageDisplay(model);
            }
        } else if (this.currentQuota.models.length > 0) {
            const lowestModel = this.currentQuota.models.reduce((prev, curr) =>
                formatPercentage(curr) < formatPercentage(prev) ? curr : prev
            );
            displayPercent = formatPercentageDisplay(lowestModel);
        }

        return displayPercent;
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

        // 2. Fallback: Use minimum percentage across all models (most restrictive)
        const percentages = this.currentQuota.models.map(m => formatPercentage(m));
        return Math.min(...percentages);
    }

    /**
     * Format detailed tooltip text using Markdown
     */
    private formatTooltip(status: 'disconnected' | 'connecting' | 'connected' | 'error'): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.supportThemeIcons = true;
        md.supportHtml = true;

        if (!this.currentQuota) {
            md.appendText('Antigravity HUD: No data');
            return md;
        }

        this.appendConnectionBanner(md, status);

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

            const statusCell = this.tooltipStatusStyle === 'battery'
                ? getBatteryBar(percent)
                : this.getTrafficLightStatus(percent);

            // Mark recommended models
            let displayModelName = model.modelName;
            if (model.isRecommended) {
                displayModelName = `★ ${displayModelName}`;
            }

            // Highlight the monitored model
            const isMonitored = this.selectedModelId === model.modelId;
            const modelNameCell = isMonitored ? `**${displayModelName}**` : displayModelName;

            const remainingStr = formatQuotaText(model);

            // Format Reset Time
            let resetStr = '-';
            if (model.resetAt) {
                const diffHours = (model.resetAt.getTime() - Date.now()) / (1000 * 60 * 60);
                if (diffHours > 24) {
                    // For reset times > 24 hours, absolute time without date is confusing.
                    // Just show relative time to save space.
                    resetStr = formatResetTime(model.resetAt); // e.g., "103h 13m"
                } else {
                    // Fits well: e.g., "18:15 (4h 59m)"
                    resetStr = `${formatAbsoluteTime(model.resetAt)} (${formatResetTime(model.resetAt)})`;
                }
            }

            md.appendMarkdown(`| ${modelNameCell} | ${statusCell} | ${remainingStr} | ${resetStr} |\n`);
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
            // Fallback to lowest
            md.appendMarkdown(`$(info) **Status Bar displays:** Lowest quota across all models (${formatPercentageDisplay(lowestModel)})\n\n`);
            targetModel = lowestModel;
        }

        // Add stats for target model
        if (targetModel) {
            const stats = this.statsManager.getModelStats(targetModel.modelId, !!targetModel.isLikelyBucketed);
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

        // Add AI Credits
        if (this.currentQuota.aiCredits) {
            const credits = this.currentQuota.aiCredits;
            let creditStr = `$(zap) **AI Credits:** ${credits.remaining}`;
            if (credits.total !== undefined) {
                creditStr += ` / ${credits.total}`;
            }
            if (credits.enabled !== undefined) {
                creditStr += credits.enabled ? ' (Active)' : ' (Disabled)';
            }
            md.appendMarkdown(`${creditStr}\n\n`);
        }

        md.appendMarkdown(`$(clock) **Last updated:** ${formatTime(this.currentQuota.lastUpdated)}`);

        return md;
    }

    private appendConnectionBanner(md: vscode.MarkdownString, status: 'disconnected' | 'connecting' | 'connected' | 'error'): void {
        const ageMs = Date.now() - this.currentQuota!.lastUpdated.getTime();
        const ageMinutes = Math.max(0, Math.floor(ageMs / 60000));
        const staleHint = ageMinutes > 0 ? ` (cached ${ageMinutes}m ago)` : '';

        if (status === 'connected') {
            return;
        } else {
            // proceed
        }

        if (status === 'connecting') {
            const message = this.lastStatusMessage ? ` ${this.lastStatusMessage}` : '';
            md.appendMarkdown(`> $(sync~spin) **Connecting...**${staleHint}${message}\n\n`);
            return;
        } else {
            // proceed
        }

        if (status === 'disconnected') {
            const message = this.lastStatusMessage ? ` ${this.lastStatusMessage}` : '';
            md.appendMarkdown(`> $(circle-slash) **Disconnected.**${staleHint}${message}\n\n`);
            return;
        } else {
            // proceed
        }

        const errorText = this.lastErrorMessage ? ` ${this.lastErrorMessage}` : '';
        md.appendMarkdown(`> $(warning) **Connection error.**${staleHint}${errorText}\n\n`);
    }

    private getTrafficLightStatus(percent: number): string {
        if (percent <= 20) {
            return '🔴';
        } else if (percent <= 50) {
            return '🟡';
        } else {
            return '🟢';
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
