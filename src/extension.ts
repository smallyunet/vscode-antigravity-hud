import * as vscode from 'vscode';
import { ProcessHunter } from './core/process-hunter';
import { QuotaPoller } from './core/quota-poller';
import { ConnectionManager, ConnectionStatusEvent } from './core/connection-manager';
import { StatusBarManager } from './ui/status-bar';
import { ExtensionConfig, QuotaUpdateEvent } from './types';
import { logger } from './utils/logger';

let processHunter: ProcessHunter;
let quotaPoller: QuotaPoller;
let connectionManager: ConnectionManager;
let statusBarManager: StatusBarManager;

/**
 * Extension activation entry point
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    logger.info('Antigravity HUD activating...');

    // Get configuration
    const config = getConfiguration();

    // Initialize components
    processHunter = new ProcessHunter(logger, config.processPatterns);
    quotaPoller = new QuotaPoller(logger, config.pollingInterval, config.apiPath);
    connectionManager = new ConnectionManager(processHunter, quotaPoller, logger);
    statusBarManager = new StatusBarManager(context, config.lowQuotaThreshold, config.enableNotifications);

    // Wire up quota updates to status bar
    quotaPoller.on('update', (event: QuotaUpdateEvent) => {
        statusBarManager.update(event);
    });

    // Wire up connection status updates
    connectionManager.on('statusChange', (event: ConnectionStatusEvent) => {
        statusBarManager.setConnectionStatus(event.status);
        if (event.message && event.status === 'error') {
            // Optionally show error toast if needed, but logging + status bar is usually enough
            // status bar tooltip update could be good, but StatusBarManager needs an update for that
        }
    });

    // Register commands
    const showQuotaCmd = vscode.commands.registerCommand(
        'antigravity-hud.showQuota',
        () => statusBarManager.showQuotaDetails()
    );

    const refreshCmd = vscode.commands.registerCommand(
        'antigravity-hud.refresh',
        () => connectionManager.refresh()
    );

    const selectModelCmd = vscode.commands.registerCommand(
        'antigravity-hud.selectModel',
        () => statusBarManager.selectModel()
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
        refreshCmd,
        selectModelCmd,
        configWatcher,
        { dispose: () => cleanup() }
    );

    // Start connection attempt
    await connectionManager.connect();

    logger.info('Antigravity HUD activated');
}

/**
 * Get extension configuration
 */
function getConfiguration(): ExtensionConfig {
    const config = vscode.workspace.getConfiguration('antigravity-hud');
    return {
        pollingInterval: config.get<number>('pollingInterval', 60),
        processPatterns: config.get<string[]>('processPatterns', ['antigravity', 'gemini-ls', 'gemini-code']),
        apiPath: config.get<string>('apiPath', '/exa.language_server_pb.LanguageServerService/GetUnleashData'),
        lowQuotaThreshold: config.get<number>('lowQuotaThreshold', 20),
        enableNotifications: config.get<boolean>('enableNotifications', true)
    };
}

/**
 * Handle configuration changes
 */
function handleConfigurationChange(): void {
    const config = getConfiguration();

    logger.info('Configuration changed, updating...');
    processHunter.setProcessPatterns(config.processPatterns);
    quotaPoller.setPollingInterval(config.pollingInterval);
    quotaPoller.setApiPath(config.apiPath);
    statusBarManager.updateConfig(config.lowQuotaThreshold, config.enableNotifications);

    // Trigger a refresh on config change to ensure we use new settings if needed
    connectionManager.refresh();
}

/**
 * Cleanup resources
 */
function cleanup(): void {
    logger.info('Cleaning up Antigravity HUD...');

    connectionManager.disconnect();
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
