import { QuotaResponse, ModelQuota } from '../types';

/**
 * Parse raw API response into QuotaResponse
 */
export function parseQuotaResponse(data: any): QuotaResponse {
    const models: ModelQuota[] = [];

    try {
        let rawModels: any[] = [];

        // 1. Try to find the detailed model configurations first (Priority)
        if (data?.user_status?.cascade_model_config_data?.client_model_configs) {
            rawModels = data.user_status.cascade_model_config_data.client_model_configs;
        } else if (data?.userStatus?.cascadeModelConfigData?.clientModelConfigs) {
            rawModels = data.userStatus.cascadeModelConfigData.clientModelConfigs;
        } else if (data?.models && Array.isArray(data.models)) {
            rawModels = data.models;
        }

        // 2. If no detailed models found, check for legacy "plan_status" credits
        if (rawModels.length === 0) {
            if (data?.user_status?.plan_status) {
                const credits = data.user_status.plan_status.available_prompt_credits || 0;
                return {
                    models: [{
                        modelId: 'credits',
                        modelName: 'Available Credits',
                        remaining: credits,
                        limit: 1000,
                        resetAt: undefined
                    }],
                    lastUpdated: new Date()
                };
            } else if (data?.userStatus?.planStatus) {
                const credits = data.userStatus.planStatus.availablePromptCredits || 0;
                return {
                    models: [{
                        modelId: 'credits',
                        modelName: 'Available Credits',
                        remaining: credits,
                        limit: 1000,
                        resetAt: undefined
                    }],
                    lastUpdated: new Date()
                };
            }
        }

        if (rawModels.length > 0) {
            for (const m of rawModels) {
                // Normalize fields
                // Handle nested modelOrAlias structure (observed in wild)
                let modelId = m.model_id || m.modelId || m.id;
                if (!modelId && m.modelOrAlias?.model) {
                    modelId = m.modelOrAlias.model;
                }

                // Handle nested quotaInfo structure (observed in wild)
                const quotaInfo = m.quotaInfo || {};

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
                } else if (quotaInfo.remainingFraction !== undefined) {
                    // Handle nested quotaInfo.remainingFraction
                    remaining = Math.round(Number(quotaInfo.remainingFraction) * 100);
                }

                if (m.limit !== undefined) limit = Number(m.limit);
                else if (m.total !== undefined) limit = Number(m.total);
                // If no explicit limit, we assume 100 for percentage-based

                let resetAt: Date | undefined = undefined;
                if (m.reset_at) resetAt = new Date(m.reset_at);
                else if (m.resetAt) resetAt = new Date(m.resetAt);
                else if (m.reset_time) resetAt = new Date(m.reset_time);
                else if (m.resetTime) resetAt = new Date(m.resetTime);
                else if (quotaInfo.resetTime) resetAt = new Date(quotaInfo.resetTime);

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
            console.warn('Could not find model data in response. Full data:', JSON.stringify(data));
        }

    } catch (e) {
        console.error('Error parsing quota response', e);
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
