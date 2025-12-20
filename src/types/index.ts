/**
 * Type definitions for Antigravity HUD
 */

/**
 * Process information extracted from system process list
 */
export interface ProcessInfo {
    pid: number;
    name: string;
    commandLine: string;
}

/**
 * Antigravity connection details extracted from process arguments
 */
export interface AntigravityConnection {
    port: number;
    token: string;
    pid: number;
}

/**
 * Single model quota information
 */
export interface ModelQuota {
    modelId: string;
    modelName: string;
    remaining: number;
    limit: number;
    resetAt?: Date;
}

/**
 * Complete quota response from API
 */
export interface QuotaResponse {
    models: ModelQuota[];
    lastUpdated: Date;
}

/**
 * Quota update event payload
 */
export interface QuotaUpdateEvent {
    quota: QuotaResponse | null;
    error?: Error;
}

/**
 * Configuration settings for the extension
 */
export interface ExtensionConfig {
    pollingInterval: number;
    processPatterns: string[];
    apiPath: string;
    lowQuotaThreshold: number;
    enableNotifications: boolean;
}
