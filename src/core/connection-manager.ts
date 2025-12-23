import { EventEmitter } from 'events';
import { ProcessHunter } from './process-hunter';
import { QuotaPoller } from './quota-poller';
import { AntigravityConnection, QuotaUpdateEvent } from '../types';
import { ILogger } from './interfaces';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'; // Match StatusBarManager expected types roughly

export interface ConnectionStatusEvent {
    status: ConnectionStatus;
    message?: string;
}

/**
 * ConnectionManager
 * 
 * Orchestrates ProcessHunter and QuotaPoller to ensure a persistent connection
 * to the Antigravity process. Handles retries with exponential backoff.
 */
export class ConnectionManager extends EventEmitter {
    private processHunter: ProcessHunter;
    private quotaPoller: QuotaPoller;
    private logger: ILogger;
    private status: ConnectionStatus = 'disconnected';

    // Retry configuration
    private retryCount: number = 0;
    private retryTimer: NodeJS.Timeout | null = null;
    private readonly maxBackoffMs: number = 30000;
    private readonly baseBackoffMs: number = 2000;

    constructor(processHunter: ProcessHunter, quotaPoller: QuotaPoller, logger: ILogger) {
        super();
        this.processHunter = processHunter;
        this.quotaPoller = quotaPoller;
        this.logger = logger;

        // Listen to poller errors to trigger reconnection
        this.quotaPoller.on('update', (event: QuotaUpdateEvent) => {
            if (event.error) {
                this.handlePollError(event.error);
            } else if (event.quota) {
                // Successful poll resets retry count
                if (this.retryCount > 0) {
                    this.retryCount = 0;
                    this.logger.debug('Connection stable, retry count reset');
                }

                // Ensure status is connected if we are getting data
                if (this.status !== 'connected') {
                    this.setStatus('connected');
                }
            }
        });
    }

    /**
     * Start the connection process
     */
    public async connect(): Promise<void> {
        // Avoid parallel connection attempts
        if (this.status === 'connecting' || this.status === 'connected') {
            return;
        }

        this.setStatus('connecting');
        this.stopRetryTimer();

        try {
            this.logger.info(`Attempting connection (Attempt ${this.retryCount + 1})...`);

            const connection = await this.processHunter.hunt();

            if (connection) {
                this.logger.info(`Connection successful to PID ${connection.pid}`);
                this.quotaPoller.setConnection(connection);
                this.quotaPoller.start();
                this.setStatus('connected');
                this.retryCount = 0; // Reset on success
            } else {
                this.logger.info('No connection found during hunt');
                this.scheduleRetry('No Antigravity process found');
            }
        } catch (error) {
            this.logger.error('Connection attempt failed', error);
            this.scheduleRetry('Connection attempt failed');
        }
    }

    /**
     * Stop connection and retries
     */
    public disconnect(): void {
        this.stopRetryTimer();
        this.quotaPoller.stop();
        this.setStatus('disconnected');
    }

    /**
     * Manually refresh connection
     */
    public async refresh(): Promise<void> {
        this.disconnect();
        this.retryCount = 0;
        await this.connect();
    }

    private handlePollError(error: Error): void {
        // If we get an error, we should verify if it's fatal (like connection refused)
        // For now, we assume most poll errors imply connection issues

        // Don't spam retries if we are already disconnected/reconnecting
        if (this.status === 'disconnected' || this.status === 'connecting') {
            return;
        }

        this.logger.warn(`Poll error detected: ${error.message}`);

        // Stop the poller to prevent more errors while we reconnect
        this.quotaPoller.stop();
        this.setStatus('error', error.message);

        this.scheduleRetry('Connection lost');
    }

    private scheduleRetry(reason: string): void {
        const backoffMs = Math.min(
            this.baseBackoffMs * Math.pow(2, this.retryCount),
            this.maxBackoffMs
        );

        this.logger.info(`${reason}. Retrying in ${backoffMs / 1000}s...`);

        this.setStatus('disconnected', `${reason}. Retrying in ${backoffMs / 1000}s...`);

        this.stopRetryTimer();
        this.retryTimer = setTimeout(() => {
            this.retryCount++;
            this.connect();
        }, backoffMs);
    }

    private stopRetryTimer(): void {
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    private setStatus(status: ConnectionStatus, message?: string): void {
        if (this.status !== status) {
            this.status = status;
            this.emit('statusChange', { status, message });
        }
    }

    public getStatus(): ConnectionStatus {
        return this.status;
    }
}
