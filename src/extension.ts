import * as vscode from 'vscode';
import { ProcessHunter } from './core/process-hunter';
import { QuotaPoller } from './core/quota-poller';
import { StatusBarManager } from './ui/status-bar';
import { ExtensionConfig, QuotaUpdateEvent } from './types';
import { logger } from './utils/logger';

let processHunter: ProcessHunter;
let quotaPoller: QuotaPoller;
let statusBarManager: StatusBarManager;
let reconnectTimer: NodeJS.Timeout | null = null;

/**
 * Extension activation entry point
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    logger.info('Antigravity HUD activating...');

    // Get configuration
    const config = getConfiguration();

    // Initialize components
    processHunter = new ProcessHunter(config.processPatterns);
    quotaPoller = new QuotaPoller(config.pollingInterval, config.apiPath);
    statusBarManager = new StatusBarManager(context, config.lowQuotaThreshold, config.enableNotifications);

    // Wire up quota updates to status bar
    quotaPoller.on('update', (event: QuotaUpdateEvent) => {
        statusBarManager.update(event);
    });

    // Register commands
    const showQuotaCmd = vscode.commands.registerCommand(
        'antigravity-hud.showQuota',
        () => statusBarManager.showQuotaDetails()
    );

    const refreshCmd = vscode.commands.registerCommand(
        'antigravity-hud.refresh',
        () => refreshConnection()
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
    await initializeConnection();

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
}

/**
 * Initialize connection to Antigravity process
 */
async function initializeConnection(): Promise<void> {
    statusBarManager.setConnectionStatus('connecting');

    try {
        const connection = await processHunter.hunt();

        if (connection) {
            logger.info(`Connected to Antigravity process (PID: ${connection.pid})`);
            quotaPoller.setConnection(connection);
            quotaPoller.start();
            statusBarManager.setConnectionStatus('connected');
        } else {
            logger.info('No Antigravity process found, will retry...');
            statusBarManager.setConnectionStatus('disconnected');
            scheduleReconnect();
        }
    } catch (error) {
        logger.error('Failed to initialize connection', error);
        statusBarManager.setConnectionStatus('error');
        scheduleReconnect();
    }
}

/**
 * Refresh connection (manual trigger)
 */
async function refreshConnection(): Promise<void> {
    logger.info('Manual refresh triggered');

    // Cancel any pending reconnect
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    // Stop current polling
    quotaPoller.stop();

    // Reinitialize
    await initializeConnection();

    // If we have a connection, poll immediately
    if (quotaPoller.isActive()) {
        await quotaPoller.poll();
    }
}

/**
 * Schedule a reconnection attempt
 */
function scheduleReconnect(): void {
    if (reconnectTimer) {
        return; // Already scheduled
    }

    // Retry every 30 seconds
    const reconnectInterval = 30000;
    logger.debug(`Scheduling reconnect in ${reconnectInterval / 1000}s`);

    reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        await initializeConnection();
    }, reconnectInterval);
}

/**
 * Cleanup resources
 */
function cleanup(): void {
    logger.info('Cleaning up Antigravity HUD...');

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    quotaPoller.stop();
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
