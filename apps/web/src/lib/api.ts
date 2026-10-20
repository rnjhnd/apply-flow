import { healthResponseSchema } from '@applyflow/contracts';

export async function checkApiHealth(signal: AbortSignal) {
  const response = await fetch('/api/v1/health/live', {
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    cache: 'no-store'
  });
  if (!response.ok) throw new Error('API request failed');
  return healthResponseSchema.parse(await response.json());
}
