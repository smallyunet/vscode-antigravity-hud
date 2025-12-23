import { EventEmitter } from 'events';
import * as https from 'https';
import { AntigravityConnection, QuotaResponse, ModelQuota, QuotaUpdateEvent, ServerUserStatusResponse, ModelQuotaInfo } from '../types';
import { logger } from '../utils/logger';
import { parseQuotaResponse } from './quota-parser';

/**
 * QuotaPoller - Polls Antigravity API for quota information
 * 
 * Uses the connection details from ProcessHunter to periodically
 * fetch quota data from the local Antigravity API.
 */
export class QuotaPoller extends EventEmitter {
    private connection: AntigravityConnection | null = null;
    private pollingInterval: number;
    private timer: NodeJS.Timeout | null = null;
    private isPolling: boolean = false;
    private lastQuota: QuotaResponse | null = null;

    private apiPath: string;

    constructor(pollingIntervalSeconds: number = 60, apiPath: string = '/exa.language_server_pb.LanguageServerService/GetUserStatus') {
        super();
        this.pollingInterval = pollingIntervalSeconds * 1000;
        this.apiPath = apiPath;
        logger.info(`QuotaPoller initialized with ${pollingIntervalSeconds}s interval, path: ${apiPath}`);
    }

    /**
     * Set the Antigravity connection details
     */
    setConnection(connection: AntigravityConnection | null): void {
        this.connection = connection;
        if (connection) {
            logger.info(`Connection set: port=${connection.port}, pid=${connection.pid}`);
        } else {
            logger.info('Connection cleared');
        }
    }

    /**
     * Start polling for quota updates
     */
    start(): void {
        if (this.isPolling) {
            logger.debug('Already polling, ignoring start request');
            return;
        }

        if (!this.connection) {
            logger.warn('Cannot start polling: no connection available');
            return;
        }

        this.isPolling = true;
        logger.info('Starting quota polling');

        // Initial poll
        this.poll();

        // Set up interval
        this.timer = setInterval(() => {
            this.poll();
        }, this.pollingInterval);
    }

    /**
     * Stop polling
     */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.isPolling = false;
        logger.info('Quota polling stopped');
    }

    /**
     * Perform a single poll
     */
    async poll(): Promise<void> {
        if (!this.connection) {
            this.emitUpdate(null, new Error('No connection available'));
            return;
        }

        try {
            // Use https module directly to handle self-signed certs easily
            const options = {
                hostname: '127.0.0.1',
                port: this.connection.port,
                path: this.apiPath,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Codeium-Csrf-Token': this.connection.csrfToken || this.connection.token,
                    'Connect-Protocol-Version': '1',
                },
                rejectUnauthorized: false,
                timeout: 10000
            };

            logger.debug(`Polling quota from port ${this.connection.port}`);

            const data = await new Promise<any>((resolve, reject) => {
                const req = https.request(options, (res) => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                        return;
                    }

                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(body));
                        } catch (e) {
                            reject(e);
                        }
                    });
                });

                req.on('error', reject);
                req.on('timeout', () => {
                    req.destroy();
                    reject(new Error('Request timed out'));
                });

                req.write(JSON.stringify({
                    wrapper_data: {},
                    metadata: {
                        ide_name: 'antigravity',
                        extension_name: 'antigravity',
                        locale: 'en'
                    }
                }));
                req.end();
            });

            logger.debug('Quota API response received', { size: JSON.stringify(data).length });

            const quota = parseQuotaResponse(data);
            this.lastQuota = quota;

            // Log the quota update for user verification (requests by user)
            if (quota.models.length > 0) {
                const modelLog = quota.models.map(m => {
                    const pct = m.limit > 0 ? ((m.remaining / m.limit) * 100).toFixed(2) : '0.00';
                    return `    ${m.modelName.padEnd(30)} : ${pct}%`;
                }).join('\n');
                logger.info(`Quota Update:\n${modelLog}`);
            }

            this.emitUpdate(quota);

        } catch (error) {
            logger.error('Poll failed', error);
            this.emitUpdate(null, error as Error);
        }
    }

    /**
     * Parse raw API response into QuotaResponse
     */

    /**
     * Emit quota update event
     */
    private emitUpdate(quota: QuotaResponse | null, error?: Error): void {
        const event: QuotaUpdateEvent = { quota, error };
        this.emit('update', event);
    }

    /**
     * Get the last known quota
     */
    getLastQuota(): QuotaResponse | null {
        return this.lastQuota;
    }

    /**
     * Update polling interval
     */
    setPollingInterval(seconds: number): void {
        this.pollingInterval = seconds * 1000;
        logger.info(`Polling interval updated to ${seconds}s`);

        // Restart polling if active
        if (this.isPolling) {
            this.stop();
            this.start();
        }
    }

    /**
     * Update API Path
     */
    setApiPath(path: string): void {
        this.apiPath = path;
        logger.info(`API path updated to ${path}`);
    }

    /**
     * Check if currently polling
     */
    isActive(): boolean {
        return this.isPolling;
    }
}
