import { z } from 'zod';

const timezoneSchema = z.string().trim().min(1).refine((value) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'Must be a supported timezone identifier');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.string().regex(/^\d+$/, 'Must be an integer port')
    .transform(Number).pipe(z.number().int().min(1).max(65535)).default(3000),
  APP_TIMEZONE: timezoneSchema.default('Asia/Manila')
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment configuration: ${fields.join('; ')}`);
  }
  return result.data;
}
