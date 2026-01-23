import { EventEmitter } from 'events';
import * as https from 'https';
import { AntigravityConnection, QuotaResponse, ModelQuota, QuotaUpdateEvent, ServerUserStatusResponse, ModelQuotaInfo } from '../types';
import { ILogger } from './interfaces';
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
    private logger: ILogger;

    private apiPath: string;
    private fallbackApiPaths: string[] = [];
    private inFlight: boolean = false;
    private logQuotaUpdates: boolean = false;

    constructor(logger: ILogger, pollingIntervalSeconds: number = 60, apiPath: string = '/exa.language_server_pb.LanguageServerService/GetUserStatus') {
        super();
        this.logger = logger;
        this.pollingInterval = pollingIntervalSeconds * 1000;
        this.apiPath = apiPath;
        this.logger.info(`QuotaPoller initialized with ${pollingIntervalSeconds}s interval, path: ${apiPath}`);
    }

    /**
     * Provide fallback API paths to try when the configured apiPath fails.
     */
    setFallbackApiPaths(paths: string[]): void {
        const normalized: string[] = [];

        for (const rawPath of paths) {
            if (!rawPath) {
                continue;
            }

            const trimmed = rawPath.trim();
            if (!trimmed) {
                continue;
            }

            const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
            if (!normalized.includes(withLeadingSlash)) {
                normalized.push(withLeadingSlash);
            }
        }

        this.fallbackApiPaths = normalized;
        this.logger.debug(`Fallback API paths updated: ${JSON.stringify(this.fallbackApiPaths)}`);
    }

    /**
     * Enable or disable verbose quota logging.
     */
    setLogQuotaUpdates(enabled: boolean): void {
        this.logQuotaUpdates = enabled;
        this.logger.info(`Quota update logging ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Set the Antigravity connection details
     */
    setConnection(connection: AntigravityConnection | null): void {
        this.connection = connection;
        if (connection) {
            this.logger.info(`Connection set: port=${connection.port}, pid=${connection.pid}`);
        } else {
            this.logger.info('Connection cleared');
        }
    }

    /**
     * Start polling for quota updates
     */
    start(): void {
        if (this.isPolling) {
            this.logger.debug('Already polling, ignoring start request');
            return;
        }

        if (!this.connection) {
            this.logger.warn('Cannot start polling: no connection available');
            return;
        }

        this.isPolling = true;
        this.logger.info('Starting quota polling');

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
        this.logger.info('Quota polling stopped');
    }

    /**
     * Perform a single poll
     */
    async poll(): Promise<void> {
        if (!this.connection) {
            this.emitUpdate(null, new Error('No connection available'));
            return;
        }

        if (this.inFlight) {
            this.logger.debug('Poll skipped: previous request still in-flight');
            return;
        }

        this.inFlight = true;

        try {
            const quota = await this.pollWithFallbacks();
            this.lastQuota = quota;

            this.logQuotaUpdateIfEnabled(quota);

            this.emitUpdate(quota);

        } catch (error) {
            this.logger.error('Poll failed', error);
            this.emitUpdate(null, error as Error);
        } finally {
            this.inFlight = false;
        }
    }

    private async pollWithFallbacks(): Promise<QuotaResponse> {
        const pathsToTry = this.getPathsToTry();

        let lastError: Error | null = null;

        for (const path of pathsToTry) {
            const result = await this.fetchQuota(path);

            if (result.ok) {
                if (path !== this.apiPath) {
                    this.apiPath = path;
                    this.logger.info(`API path auto-switched to ${path}`);
                }
                return result.quota;
            }

            lastError = result.error;

            if (result.isPathRelatedError) {
                continue;
            } else {
                break;
            }
        }

        if (lastError) {
            throw lastError;
        }

        throw new Error('Poll failed: no usable API paths');
    }

    private getPathsToTry(): string[] {
        const paths: string[] = [];

        if (this.apiPath && this.apiPath.trim()) {
            const primary = this.apiPath.startsWith('/') ? this.apiPath : `/${this.apiPath}`;
            paths.push(primary);
        }

        for (const p of this.fallbackApiPaths) {
            if (!paths.includes(p)) {
                paths.push(p);
            }
        }

        return paths;
    }

    private async fetchQuota(path: string): Promise<{ ok: true; quota: QuotaResponse } | { ok: false; error: Error; isPathRelatedError: boolean }> {
        if (!this.connection) {
            return { ok: false, error: new Error('No connection available'), isPathRelatedError: false };
        }

        const options = {
            hostname: '127.0.0.1',
            port: this.connection.port,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Codeium-Csrf-Token': this.connection.csrfToken || this.connection.token,
                'Connect-Protocol-Version': '1'
            },
            rejectUnauthorized: false,
            timeout: 10000
        };

        this.logger.debug(`Polling quota from port ${this.connection.port} path=${path}`);

        const response = await new Promise<{ statusCode?: number; statusMessage?: string; body: string }>((resolve, reject) => {
            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    resolve({ statusCode: res.statusCode, statusMessage: res.statusMessage, body });
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

        if (response.statusCode !== 200) {
            const status = response.statusCode ? response.statusCode.toString() : 'unknown';
            const message = response.statusMessage ? response.statusMessage : 'unknown';
            const error = new Error(`HTTP ${status}: ${message}`);

            const isPathRelatedError = response.statusCode === 404 || response.statusCode === 405 || response.statusCode === 501;
            return { ok: false, error, isPathRelatedError };
        }

        let data: any;
        try {
            data = JSON.parse(response.body);
        } catch (e) {
            const error = new Error('Failed to parse JSON response');
            return { ok: false, error, isPathRelatedError: true };
        }

        try {
            const quota = parseQuotaResponse(data, this.logger);
            return { ok: true, quota };
        } catch (e) {
            const error = new Error('Failed to parse quota response');
            return { ok: false, error, isPathRelatedError: true };
        }
    }

    private logQuotaUpdateIfEnabled(quota: QuotaResponse): void {
        if (!this.logQuotaUpdates) {
            return;
        }

        if (quota.models.length === 0) {
            return;
        }

        const modelLog = quota.models.map(m => {
            const pct = m.limit > 0 ? ((m.remaining / m.limit) * 100).toFixed(2) : '0.00';
            return `    ${m.modelName.padEnd(30)} : ${pct}%`;
        }).join('\n');

        this.logger.info(`Quota Update:\n${modelLog}`);
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
        this.logger.info(`Polling interval updated to ${seconds}s`);

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
        this.logger.info(`API path updated to ${path}`);
    }

    /**
     * Check if currently polling
     */
    isActive(): boolean {
        return this.isPolling;
    }
}
