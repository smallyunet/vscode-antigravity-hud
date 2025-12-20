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
/**
 * Antigravity connection details extracted from process arguments
 */
export interface AntigravityConnection {
    port: number;
    token: string; // Kept for backward compatibility if needed, or alias for csrfToken
    csrfToken: string;
    pid: number;
}

/**
 * Model info used in GetUnleashData response
 */
export interface ModelQuotaInfo {
    modelId: string;
    modelName?: string;
    remaining?: number; // Could be remaining or remainingPercentage
    remainingFraction?: number;
    limit?: number;
    resetTime?: string; // Date string
    resetAt?: Date;
}

/**
 * Server User Status Response (wrapper_data)
 */
export interface ServerUserStatusResponse {
    userStatus: {
        planStatus?: {
            availablePromptCredits: number;
        }
    }
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
