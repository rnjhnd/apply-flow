import { z } from 'zod';

export const healthResponseSchema = z.strictObject({
  status: z.literal('ok'),
  service: z.literal('applyflow-api')
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
