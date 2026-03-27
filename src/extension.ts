import * as vscode from 'vscode';
import { ProcessHunter } from './core/process-hunter';
import { QuotaPoller } from './core/quota-poller';
import { ConnectionManager, ConnectionStatusEvent } from './core/connection-manager';
import { StatisticsManager } from './core/statistics-manager';
import { StatusBarManager } from './ui/status-bar';
import { ExtensionConfig, QuotaUpdateEvent } from './types';
import { logger } from './utils/logger';

let processHunter: ProcessHunter;
let quotaPoller: QuotaPoller;
let connectionManager: ConnectionManager;
let statusBarManager: StatusBarManager;
let statisticsManager: StatisticsManager;

/**
 * Extension activation entry point
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    logger.info('Antigravity HUD activating...');

    // Get configuration
    const config = getConfiguration();

    // Initialize components
    processHunter = new ProcessHunter(logger, config.processPatterns, buildVerificationPaths(config.apiPath));
    quotaPoller = new QuotaPoller(logger, config.pollingInterval, config.apiPath);
    quotaPoller.setFallbackApiPaths(buildVerificationPaths(config.apiPath));
    quotaPoller.setLogQuotaUpdates(config.logQuotaUpdates);
    connectionManager = new ConnectionManager(processHunter, quotaPoller, logger);
    statisticsManager = new StatisticsManager(context);
    statusBarManager = new StatusBarManager(
        context,
        statisticsManager,
        config.lowQuotaThreshold,
        config.enableNotifications,
        config.tooltipStatusStyle
    );

    // Wire up quota updates to status bar and stats manager
    quotaPoller.on('update', (event: QuotaUpdateEvent) => {
        statisticsManager.processQuotaUpdate(event.quota);
        statusBarManager.update(event);
    });

    // Wire up connection status updates
    connectionManager.on('statusChange', (event: ConnectionStatusEvent) => {
        statusBarManager.setConnectionStatus(event.status, event.message);
    });

    // Register commands
    const showQuotaCmd = vscode.commands.registerCommand(
        'antigravity-hud.showQuota',
        () => statusBarManager.showQuotaDetails()
    );

    const openSettingsModelsCmd = vscode.commands.registerCommand(
        'antigravity-hud.openSettingsModels',
        async () => {
            const allCommands = await vscode.commands.getCommands(true);
            
            // Find all settings-related Antigravity/Gemini commands
            const settingsCommands = allCommands.filter(cmd => {
                const lower = cmd.toLowerCase();
                const isRelevantExtension = lower.includes('antigravity') || lower.includes('gemini');
                const isSettings = lower.includes('setting');
                return isRelevantExtension && isSettings;
            });

            logger.info(`Found settings commands: ${JSON.stringify(settingsCommands)}`);

            if (settingsCommands.length > 0) {
                // Prefer commands with 'model' in the name
                const modelCmd = settingsCommands.find(c => c.toLowerCase().includes('model'));
                const cmdToUse = modelCmd || settingsCommands[0];
                
                try {
                    await vscode.commands.executeCommand(cmdToUse);
                    logger.info(`Opened Settings via command: ${cmdToUse}`);
                    return;
                } catch (e) {
                    logger.warn(`Failed to execute ${cmdToUse}: ${e}`);
                }
            }

            // Fallback: open VS Code settings filtered to antigravity
            logger.info('No Antigravity/Gemini settings command found, falling back');
            await vscode.commands.executeCommand('workbench.action.openSettings', 'antigravity-hud');
        }
    );

    const refreshCmd = vscode.commands.registerCommand(
        'antigravity-hud.refresh',
        () => connectionManager.refresh()
    );

    const diagnosticsCmd = vscode.commands.registerCommand(
        'antigravity-hud.diagnostics',
        async () => {
            logger.show();
            await processHunter.diagnose();
        }
    );

    const selectModelCmd = vscode.commands.registerCommand(
        'antigravity-hud.selectModel',
        () => statusBarManager.selectModel()
    );

    const clearMonitoredModelCmd = vscode.commands.registerCommand(
        'antigravity-hud.clearMonitoredModel',
        () => statusBarManager.clearMonitoredModel()
    );

    const resetStatisticsCmd = vscode.commands.registerCommand(
        'antigravity-hud.resetStatistics',
        () => statusBarManager.resetStatistics()
    );

    // Listen for configuration changes
    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('antigravity-hud')) {
            handleConfigurationChange();
        }
    });

    // Register disposables
    context.subscriptions.push(
        showQuotaCmd,
        openSettingsModelsCmd,
        refreshCmd,
        diagnosticsCmd,
        selectModelCmd,
        clearMonitoredModelCmd,
        resetStatisticsCmd,
        configWatcher,
        { dispose: () => cleanup() }
    );

    // Start connection attempt
    await connectionManager.connect();

    logger.info('Antigravity HUD activated');
}

function buildVerificationPaths(configuredApiPath: string): string[] {
    return [
        configuredApiPath,
        '/exa.language_server_pb.LanguageServerService/GetUserStatus',
        '/exa.language_server_pb.LanguageServerService/GetUnleashData'
    ];
}

/**
 * Get extension configuration
 */
function getConfiguration(): ExtensionConfig {
    const config = vscode.workspace.getConfiguration('antigravity-hud');
    return {
        pollingInterval: config.get<number>('pollingInterval', 60),
        processPatterns: config.get<string[]>('processPatterns', ['antigravity', 'language_server', 'gemini-ls', 'gemini-code']),
        apiPath: config.get<string>('apiPath', '/exa.language_server_pb.LanguageServerService/GetUserStatus'),
        lowQuotaThreshold: config.get<number>('lowQuotaThreshold', 20),
        enableNotifications: config.get<boolean>('enableNotifications', false),
        logQuotaUpdates: config.get<boolean>('logQuotaUpdates', false),
        tooltipStatusStyle: config.get<'battery' | 'traffic'>('tooltipStatusStyle', 'battery')
    };
}

/**
 * Handle configuration changes
 */
function handleConfigurationChange(): void {
    const config = getConfiguration();

    logger.info('Configuration changed, updating...');
    processHunter.setProcessPatterns(config.processPatterns);
    processHunter.setVerificationPaths(buildVerificationPaths(config.apiPath));
    quotaPoller.setPollingInterval(config.pollingInterval);
    quotaPoller.setApiPath(config.apiPath);
    quotaPoller.setFallbackApiPaths(buildVerificationPaths(config.apiPath));
    quotaPoller.setLogQuotaUpdates(config.logQuotaUpdates);
    statusBarManager.updateConfig(config.lowQuotaThreshold, config.enableNotifications, config.tooltipStatusStyle);

    // Trigger a refresh on config change to ensure we use new settings if needed
    connectionManager.refresh();
}

/**
 * Cleanup resources
 */
function cleanup(): void {
    logger.info('Cleaning up Antigravity HUD...');

    connectionManager.disconnect();
    statisticsManager.dispose();
    statusBarManager.dispose();
    logger.dispose();
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
    // Cleanup is handled by disposables
    logger.info('Antigravity HUD deactivated');
}
