import { expect } from 'chai';
import { parseQuotaResponse } from '../../core/quota-parser';

describe('QuotaParser', () => {
    it('should parse client_model_configs correctly', () => {
        const data = {
            user_status: {
                cascade_model_config_data: {
                    client_model_configs: [
                        {
                            model_id: 'model-a',
                            model_name: 'Model A',
                            remaining: 50,
                            limit: 100,
                            reset_at: '2023-01-01T00:00:00Z'
                        }
                    ]
                }
            }
        };

        const result = parseQuotaResponse(data);
        expect(result.models).to.have.lengthOf(1);
        expect(result.models[0].modelId).to.equal('model-a');
        expect(result.models[0].modelName).to.equal('Model A');
        expect(result.models[0].remaining).to.equal(50);
        expect(result.models[0].limit).to.equal(100);
        expect(result.models[0].resetAt?.toISOString()).to.equal('2023-01-01T00:00:00.000Z');
    });

    it('should handle percentage based quotas', () => {
        const data = {
            models: [
                {
                    model_id: 'model-b',
                    remaining_percentage: 0.75,
                    limit: 100
                }
            ]
        };

        const result = parseQuotaResponse(data);
        expect(result.models[0].remaining).to.equal(75);
    });

    it('should fallback to legacy plan_status if no models found', () => {
        const data = {
            user_status: {
                plan_status: {
                    available_prompt_credits: 500
                }
            }
        };

        const result = parseQuotaResponse(data);
        expect(result.models[0].modelId).to.equal('credits');
        expect(result.models[0].remaining).to.equal(500);
    });

    it('should return a placeholder if data is empty', () => {
        const result = parseQuotaResponse({});
        expect(result.models[0].modelId).to.equal('unknown');
    });
});
