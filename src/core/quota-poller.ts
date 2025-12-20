import { EventEmitter } from 'events';
import { AntigravityConnection, QuotaResponse, ModelQuota, QuotaUpdateEvent, ServerUserStatusResponse, ModelQuotaInfo } from '../types';
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

    private apiPath: string;

    constructor(pollingIntervalSeconds: number = 60, apiPath: string = '/exa.language_server_pb.LanguageServerService/GetUnleashData') {
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
            const url = `http://127.0.0.1:${this.connection.port}${this.apiPath}`;
            logger.debug(`Polling: ${url}`);

            const response = await this.fetchWithTimeout(url, {
                method: 'POST', // Changed to POST for gRPC-web style endpoint
                headers: {
                    'Content-Type': 'application/json',
                    'X-Codeium-Csrf-Token': this.connection.csrfToken || this.connection.token,
                    'Connect-Protocol-Version': '1',
                },
                body: JSON.stringify({ wrapper_data: {} }) // Request body needed
            }, 10000); // 10s timeout

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            logger.debug('Quota API response received', { size: JSON.stringify(data).length });

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
     */
    private parseQuotaResponse(data: any): QuotaResponse {
        const models: ModelQuota[] = [];

        try {
            // Traverse the response structure based on common gRPC-web patterns and reference repo
            // Expecting: data.userStatus.planStatus... or similar structure for quota
            // Or data.models if it returns a list directly (unlikely based on reference)

            // Reference repo implementation suggests it gets a list of models
            // Let's try to find models directly or nested

            let rawModels: any[] = [];

            // Try different paths
            if (data?.models && Array.isArray(data.models)) {
                rawModels = data.models;
            } else if (data?.user_status?.cascade_model_config_data?.client_model_configs) {
                // CamelCase might be normalized to snake_case in some proxies, checking both
                rawModels = data.user_status.cascade_model_config_data.client_model_configs;
            } else if (data?.userStatus?.cascadeModelConfigData?.clientModelConfigs) {
                rawModels = data.userStatus.cascadeModelConfigData.clientModelConfigs;
            }

            if (rawModels.length > 0) {
                for (const m of rawModels) {
                    // Normalize fields
                    const modelId = m.model_id || m.modelId || m.id;
                    const modelName = m.model_name || m.modelName || m.name || m.label || modelId;

                    // Quota logic: prefer explicit remaining count, else calculate from percentage
                    let remaining = 0;
                    let limit = 100;

                    if (m.remaining !== undefined) remaining = Number(m.remaining);
                    else if (m.left !== undefined) remaining = Number(m.left);
                    else if (m.remaining_percentage !== undefined) {
                        remaining = Math.round(Number(m.remaining_percentage) * 100);
                    } else if (m.remainingPercentage !== undefined) {
                        remaining = Math.round(Number(m.remainingPercentage) * 100);
                    } else if (m.remaining_fraction !== undefined) {
                        remaining = Math.round(Number(m.remaining_fraction) * 100);
                    }

                    if (m.limit !== undefined) limit = Number(m.limit);
                    else if (m.total !== undefined) limit = Number(m.total);

                    let resetAt: Date | undefined = undefined;
                    if (m.reset_at) resetAt = new Date(m.reset_at);
                    else if (m.resetAt) resetAt = new Date(m.resetAt);
                    else if (m.reset_time) resetAt = new Date(m.reset_time);
                    else if (m.resetTime) resetAt = new Date(m.resetTime);

                    if (modelId) {
                        models.push({
                            modelId,
                            modelName,
                            remaining,
                            limit,
                            resetAt
                        });
                    }
                }
            } else {
                logger.warn('Could not find model data in response', JSON.stringify(data).substring(0, 500));
            }

        } catch (e) {
            logger.error('Error parsing quota response', e);
        }

        // If no models found, create a placeholder based on what we saw
        if (models.length === 0) {
            models.push({
                modelId: 'unknown',
                modelName: 'Data Unavailable',
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
