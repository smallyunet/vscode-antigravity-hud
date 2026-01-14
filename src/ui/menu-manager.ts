import * as vscode from 'vscode';
import { QuotaResponse, ModelQuota } from '../types';
import { StatisticsManager } from '../core/statistics-manager';
import { formatPercentage, formatTime, formatResetTime, formatDuration, getQuickPickIcon } from './formatters';
import { logger } from '../utils/logger';

export class MenuManager {
    private statsManager: StatisticsManager;
    private onSetModel: (modelId: string | null) => void;
    private onShowQuota: () => void; // Callback to re-show main menu (back button)

    constructor(
        statsManager: StatisticsManager,
        onSetModel: (modelId: string | null) => void
    ) {
        this.statsManager = statsManager;
        this.onSetModel = onSetModel;
        this.onShowQuota = () => { }; // Initial dummy
    }

    /**
     * Show detailed quota information in a QuickPick
     */
    async showQuotaDetails(
        quota: QuotaResponse | null,
        connectionStatus: string,
        selectedModelId: string | null
    ): Promise<void> {
        // Save this context for "Back" navigation
        this.onShowQuota = () => this.showQuotaDetails(quota, connectionStatus, selectedModelId);

        if (!quota || quota.models.length === 0) {
            vscode.window.showInformationMessage(
                'Antigravity HUD: No quota data available. ' +
                (connectionStatus === 'disconnected'
                    ? 'Not connected to Antigravity process.'
                    : 'Waiting for data...')
            );
            return;
        }

        const modelItems: vscode.QuickPickItem[] = quota.models.map(model => ({
            label: `$(${getQuickPickIcon(model)}) ${model.modelName}`,
            description: model.isFractional
                ? `${formatPercentage(model)}% remaining`
                : `${model.remaining}/${model.limit}`,
            detail: this.getModelDetail(model) + (model.modelId === selectedModelId ? ' • $(verified) Monitored' : '')
        }));

        const items: vscode.QuickPickItem[] = [...modelItems];

        // Add separator and info items
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        items.push({
            label: '$(clock) Last Updated',
            description: formatTime(quota.lastUpdated)
        });
        items.push({
            label: '$(refresh) Refresh Now',
            description: 'Fetch latest quota data'
        });
        items.push({
            label: '$(settings) Select Monitored Model',
            description: 'Choose which model to show in Status Bar'
        });

        const selected = await vscode.window.showQuickPick(items, {
            title: 'Antigravity HUD - Model Quotas',
            placeHolder: 'Select an item for more info'
        });

        if (selected?.label === '$(refresh) Refresh Now') {
            vscode.commands.executeCommand('antigravity-hud.refresh');
        } else if (selected?.label === '$(settings) Select Monitored Model') {
            this.selectModel(quota, selectedModelId);
        } else if (selected) {
            // Find selected model
            const selectedModel = quota.models.find(m =>
                selected.label.includes(m.modelName)
            );
            if (selectedModel) {
                this.showModelStatistics(selectedModel, selectedModelId);
            }
        }
    }

    /**
     * Show model selection QuickPick
     */
    async selectModel(quota: QuotaResponse, selectedModelId: string | null): Promise<void> {
        if (!quota || quota.models.length === 0) {
            vscode.window.showInformationMessage('Antigravity HUD: No models available to select. Please wait for connection.');
            return;
        }

        const AUTO_ITEM: vscode.QuickPickItem = {
            label: '$(list-unordered) Auto (Lowest Quota)',
            description: 'Show minimal quota across all models',
            detail: selectedModelId === null ? 'Currently Selected' : undefined
        };

        const modelItems: vscode.QuickPickItem[] = quota.models.map(m => ({
            label: `$(${m.modelId === selectedModelId ? 'verified' : 'server'}) ${m.modelName}`,
            description: `${formatPercentage(m)}% remaining`,
            detail: m.modelId === selectedModelId ? 'Currently Selected' : undefined,
            id: m.modelId // Store ID for retrieval
        }));

        // We also add a back button if coming from somewhere? 
        // Standard QuickPick doesn't easy support "back" unless we make it recursive.
        // Let's just keep it simple.

        const selected = await vscode.window.showQuickPick([AUTO_ITEM, ...modelItems], {
            title: 'Antigravity HUD - Select Model to Monitor',
            placeHolder: 'Select a model to show in Status Bar'
        });

        if (selected) {
            if (selected === AUTO_ITEM) {
                this.onSetModel(null);
                logger.info('Model selection cleared (Auto)');
            } else {
                const selectedModel = quota.models.find(m =>
                    selected.label.includes(m.modelName)
                );
                if (selectedModel) {
                    this.onSetModel(selectedModel.modelId);
                    logger.info(`Model selected: ${selectedModel.modelName} (${selectedModel.modelId})`);
                }
            }
        }
    }

    /**
     * Show detailed statistics for a specific model
     */
    async showModelStatistics(model: ModelQuota, selectedModelId: string | null): Promise<void> {
        const stats = this.statsManager.getModelStats(model.modelId);

        const items: vscode.QuickPickItem[] = [];

        // Header - Quota Status
        const percent = formatPercentage(model);
        items.push({
            label: `$(graph) Quota Status`,
            description: model.isFractional
                ? `${percent}% remaining`
                : `${percent}% remaining (${model.remaining}/${model.limit})`,
            detail: model.resetAt ? `Resets ${formatResetTime(model.resetAt)}` : undefined
        });

        if (stats) {
            // Stats Items
            items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

            items.push({
                label: '$(history) Usage Time',
                description: formatDuration(stats.totalUsageTime),
                detail: 'Total active usage time monitored'
            });

            if (stats.last100Time) {
                items.push({
                    label: '$(clock) Time Since Full',
                    description: formatDuration(stats.usageSinceLast100),
                    detail: 'Time elapsed since quota was 100%'
                });
            }

            items.push({
                label: '$(pulse) Consumption Speed',
                description: stats.consumptionSpeed > 0
                    ? `~${stats.consumptionSpeed.toFixed(1)}% / hour`
                    : 'Calculating...',
                detail: 'Average rate of quota consumption'
            });

            if (stats.estimatedTimeRemaining) {
                items.push({
                    label: '$(hourglass) Estimated Time Remaining',
                    description: `~${Math.floor(stats.estimatedTimeRemaining / 60)}h ${Math.floor(stats.estimatedTimeRemaining % 60)}m`,
                    detail: 'Based on current consumption speed'
                });
            }

            if (stats.consumptionSpeed > 0) {
                const fullCycleHours = 100 / stats.consumptionSpeed;
                items.push({
                    label: '$(history) Est. Full Cycle',
                    description: `~${Math.floor(fullCycleHours)}h ${Math.floor((fullCycleHours % 1) * 60)}m`,
                    detail: 'Estimated time to drain 100% quota at current speed'
                });
            }
        } else {
            items.push({
                label: '$(info) Statistics',
                description: 'No statistics available yet',
                detail: 'Use the model to generate statistics'
            });
        }

        // Actions
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

        const isSelected = selectedModelId === model.modelId;
        if (!isSelected) {
            items.push({
                label: '$(check) Set as Monitored Model',
                description: 'Show this model in status bar'
            });
        } else {
            items.push({
                label: '$(verified) Currently Monitored',
                description: 'This model is currently shown in status bar'
            });
        }

        items.push({
            label: '$(arrow-left) Back',
            description: 'Return to model list'
        });

        const selected = await vscode.window.showQuickPick(items, {
            title: `Statistics: ${model.modelName}`,
            placeHolder: 'Model Statistics & Actions'
        });

        if (selected) {
            if (selected.label === '$(check) Set as Monitored Model') {
                this.onSetModel(model.modelId);
                vscode.window.showInformationMessage(`Monitoring ${model.modelName}`);
                // Re-show stats to reflect change? or close? 
                // Let's close or go back.
            } else if (selected.label === '$(arrow-left) Back') {
                this.onShowQuota(); // Navigate back
            }
        }
    }

    private getModelDetail(model: ModelQuota): string {
        const percent = formatPercentage(model);
        let detail = `${percent}% remaining`;
        if (model.resetAt) {
            detail += ` • Resets in ${formatResetTime(model.resetAt)}`;
        }
        return detail;
    }
}
