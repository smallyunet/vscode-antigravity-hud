import { EventEmitter } from 'events';
import { AntigravityConnection, QuotaResponse, ModelQuota, QuotaUpdateEvent } from '../types';
import { logger } from '../utils/logger';

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

    // API endpoint path (placeholder - adjust based on actual API)
    private static readonly API_PATH = '/api/v1/quota';

    constructor(pollingIntervalSeconds: number = 60) {
        super();
        this.pollingInterval = pollingIntervalSeconds * 1000;
        logger.info(`QuotaPoller initialized with ${pollingIntervalSeconds}s interval`);
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
            const url = `http://127.0.0.1:${this.connection.port}${QuotaPoller.API_PATH}`;
            logger.debug(`Polling: ${url}`);

            const response = await this.fetchWithTimeout(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.connection.token}`,
                    'Content-Type': 'application/json'
                }
            }, 10000); // 10s timeout

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            const quota = this.parseQuotaResponse(data);
            this.lastQuota = quota;
            this.emitUpdate(quota);

        } catch (error) {
            logger.error('Poll failed', error);
            this.emitUpdate(null, error as Error);
        }
    }

    /**
     * Fetch with timeout support
     */
    private async fetchWithTimeout(
        url: string,
        options: RequestInit,
        timeoutMs: number
    ): Promise<Response> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            return response;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Parse raw API response into QuotaResponse
     * Adjust this based on actual API response format
     */
    private parseQuotaResponse(data: unknown): QuotaResponse {
        // Expected format (adjust based on actual API):
        // {
        //   "models": [
        //     { "id": "gemini-3-pro", "name": "Gemini 3 Pro", "remaining": 85, "limit": 100, "resetAt": "..." },
        //     { "id": "claude-sonnet", "name": "Claude Sonnet", "remaining": 45, "limit": 50, "resetAt": "..." }
        //   ]
        // }

        const models: ModelQuota[] = [];

        if (data && typeof data === 'object' && 'models' in data && Array.isArray((data as { models: unknown[] }).models)) {
            for (const model of (data as { models: unknown[] }).models) {
                if (model && typeof model === 'object') {
                    const m = model as Record<string, unknown>;
                    models.push({
                        modelId: String(m.id || m.modelId || 'unknown'),
                        modelName: String(m.name || m.modelName || 'Unknown Model'),
                        remaining: Number(m.remaining ?? m.left ?? 0),
                        limit: Number(m.limit ?? m.total ?? 100),
                        resetAt: m.resetAt ? new Date(String(m.resetAt)) : undefined
                    });
                }
            }
        }

        // If no models found, create a placeholder
        if (models.length === 0) {
            logger.warn('No models found in response, using placeholder');
            models.push({
                modelId: 'unknown',
                modelName: 'Unknown',
                remaining: 0,
                limit: 100,
                resetAt: undefined
            });
        }

        return {
            models,
            lastUpdated: new Date()
        };
    }

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
     * Check if currently polling
     */
    isActive(): boolean {
        return this.isPolling;
    }
}
