import { api } from './client.ts';

export interface Subscription {
  tier: 'light' | 'medium' | 'aggressive' | null;
  status: 'trial' | 'active' | 'cancelled' | 'none';
}

export const checkout = async (
  tier: 'light' | 'medium' | 'aggressive',
): Promise<{ success: boolean; tier: string }> => {
  return api.post('/api/v1/billing/checkout', { tier });
};

export const getSubscription = async (): Promise<Subscription> => {
  return api.get('/api/v1/billing/subscription');
};
