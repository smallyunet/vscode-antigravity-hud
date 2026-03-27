import { QuotaResponse, ModelQuota } from '../types';
import { ILogger } from './interfaces';

/**
 * Parse raw API response into QuotaResponse
 */
export function parseQuotaResponse(data: any, logger?: ILogger): QuotaResponse {
    const models: ModelQuota[] = [];

    // Parse User Tier
    let userTier: string | undefined = undefined;
    if (data?.userStatus?.userTier?.name) {
        userTier = data.userStatus.userTier.name;
    } else if (data?.user_status?.userTier?.name) {
        userTier = data.user_status.userTier.name;
    }

    // Parse AI Credits universally
    let aiCredits;
    const codeAssistStatus = data?.code_assist_state || data?.codeAssistState || data?.user_status?.code_assist_state || data?.userStatus?.codeAssistState;
    const planStatus = data?.user_status?.plan_status || data?.userStatus?.planStatus;
    
    // Antigravity's settings panel uses `availableCredits` & `useAICredits`. 
    // They may exist in code_assist_state or at top/user_status levels, overriding legacy `available_prompt_credits`
    
    // Debug: dump raw response structure to find where AI credits really live
    if (logger) {
        // Dump all keys at each level
        const userStatus = data?.userStatus || data?.user_status;
        if (userStatus) {
            const usKeys = Object.keys(userStatus);
            logger.info(`QuotaParser: userStatus keys: ${JSON.stringify(usKeys)}`);
            
            // Dump all leaf values that look like credit numbers (> 100)
            for (const key of usKeys) {
                const val = userStatus[key];
                if (typeof val === 'number' && val > 100) {
                    logger.info(`QuotaParser: userStatus.${key} = ${val}`);
                } else if (typeof val === 'string' && !isNaN(Number(val)) && Number(val) > 100) {
                    logger.info(`QuotaParser: userStatus.${key} = "${val}"`);
                } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
                    const subKeys = Object.keys(val);
                    logger.info(`QuotaParser: userStatus.${key} keys: ${JSON.stringify(subKeys)}`);
                    for (const sk of subKeys) {
                        const sv = val[sk];
                        if (typeof sv === 'number') {
                            logger.info(`QuotaParser: userStatus.${key}.${sk} = ${sv}`);
                        } else if (typeof sv === 'string' && sv.length < 100) {
                            logger.info(`QuotaParser: userStatus.${key}.${sk} = "${sv}"`);
                        } else if (typeof sv === 'boolean') {
                            logger.info(`QuotaParser: userStatus.${key}.${sk} = ${sv}`);
                        } else if (typeof sv === 'object' && sv !== null && !Array.isArray(sv)) {
                            const deepKeys = Object.keys(sv);
                            logger.info(`QuotaParser: userStatus.${key}.${sk} keys: ${JSON.stringify(deepKeys)}`);
                            for (const dk of deepKeys) {
                                const dv = sv[dk];
                                if (typeof dv !== 'object') {
                                    logger.info(`QuotaParser: userStatus.${key}.${sk}.${dk} = ${JSON.stringify(dv)}`);
                                }
                            }
                        }
                    }
                }
            }
        }
        
        // Also dump top-level data keys
        if (data) {
            const topKeys = Object.keys(data);
            logger.info(`QuotaParser: top-level data keys: ${JSON.stringify(topKeys)}`);
        }
    }
    
    const candidateRemaining = 
        codeAssistStatus?.available_credits ?? codeAssistStatus?.availableCredits ??
        planStatus?.available_credits ?? planStatus?.availableCredits ??
        planStatus?.available_ai_credits ?? planStatus?.availableAiCredits ??
        data?.user_status?.available_credits ?? data?.userStatus?.availableCredits ??
        data?.available_credits ?? data?.availableCredits ??
        planStatus?.available_prompt_credits ?? planStatus?.availablePromptCredits;

    if (candidateRemaining !== undefined) {
        logger?.info(`QuotaParser: AI Credits candidateRemaining = ${candidateRemaining}`);
        
        const candidateTotal = 
            codeAssistStatus?.total_credits ?? codeAssistStatus?.totalCredits ??
            planStatus?.total_credits ?? planStatus?.totalCredits ??
            planStatus?.total_ai_credits ?? planStatus?.totalAiCredits ??
            data?.user_status?.total_credits ?? data?.userStatus?.totalCredits ??
            data?.total_credits ?? data?.totalCredits ??
            planStatus?.total_prompt_credits ?? planStatus?.totalPromptCredits;

        const candidateEnabled = 
            codeAssistStatus?.use_ai_credits ?? codeAssistStatus?.useAiCredits ??
            planStatus?.use_ai_credits ?? planStatus?.useAiCredits ??
            planStatus?.use_credits ?? planStatus?.useCredits ??
            planStatus?.credits_enabled ?? planStatus?.creditsEnabled ??
            data?.user_status?.use_ai_credits ?? data?.userStatus?.useAiCredits ??
            data?.use_ai_credits ?? data?.useAiCredits;

        aiCredits = {
            remaining: Number(candidateRemaining),
            total: candidateTotal !== undefined && candidateTotal !== null ? Number(candidateTotal) : undefined,
            enabled: candidateEnabled !== undefined && candidateEnabled !== null ? Boolean(candidateEnabled) : undefined
        };
    }

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

        // 2. If no detailed models found, check for legacy "plan_status" credits to map as a fake model
        if (rawModels.length === 0) {
            if (aiCredits) {
                return {
                    models: [{
                        modelId: 'credits',
                        modelName: 'Available Credits',
                        remaining: aiCredits.remaining,
                        limit: aiCredits.total || 1000,
                        resetAt: undefined
                    }],
                    userTier,
                    aiCredits,
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
                let isFractional = false;
                let isLikelyBucketed = false;

                if (m.remaining !== undefined) remaining = Number(m.remaining);
                else if (m.left !== undefined) remaining = Number(m.left);
                else if (m.remaining_percentage !== undefined) {
                    remaining = Math.round(Number(m.remaining_percentage) * 100);
                    isFractional = true;
                    isLikelyBucketed = true;
                } else if (m.remainingPercentage !== undefined) {
                    remaining = Math.round(Number(m.remainingPercentage) * 100);
                    isFractional = true;
                    isLikelyBucketed = true;
                } else if (m.remaining_fraction !== undefined) {
                    remaining = Math.round(Number(m.remaining_fraction) * 100);
                    isFractional = true;
                    isLikelyBucketed = true;
                } else if (quotaInfo.remainingFraction !== undefined) {
                    // Handle nested quotaInfo.remainingFraction
                    remaining = Math.round(Number(quotaInfo.remainingFraction) * 100);
                    isFractional = true;
                    isLikelyBucketed = true;
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
                    // Heuristic: If limit is 100 and remaining is a multiple of 20, 
                    // or it's a known model type, it's likely bucketed.
                    if (limit === 100 && (remaining % 20 === 0)) {
                        isLikelyBucketed = true;
                    }

                    const isRecommended = !!m.isRecommended;

                    models.push({
                        modelId,
                        modelName,
                        remaining,
                        limit,
                        resetAt,
                        isFractional,
                        isLikelyBucketed,
                        isRecommended
                    });
                }
            }
        } else {
            logger?.debug('QuotaParser: model data not found in response');
        }

    } catch (e) {
        logger?.error('QuotaParser: failed to parse quota response', e);
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
        userTier,
        aiCredits,
        lastUpdated: new Date()
    };
}
