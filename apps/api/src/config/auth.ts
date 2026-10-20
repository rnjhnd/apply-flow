import { z } from 'zod';
import { parseEnv } from './env.js';

const authConfiguration = z.object({
  APP_ORIGIN: z.string().optional(),
  ALLOW_LOCAL_REGISTRATION: z.enum(['true', 'false']).default('false').transform((value) => value === 'true')
});

export function parseAuthConfig(source: Record<string, string | undefined>) {
  const { NODE_ENV } = parseEnv(source);
  const parsed = authConfiguration.safeParse(source);
  if (!parsed.success) throw new Error('Invalid authentication configuration: check APP_ORIGIN and ALLOW_LOCAL_REGISTRATION.');
  const origin = parsed.data.APP_ORIGIN ?? (NODE_ENV === 'production' ? '' : 'http://127.0.0.1:5173');
  try {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password
      || !['http:', 'https:'].includes(url.protocol)
      || (NODE_ENV === 'production' && url.protocol !== 'https:')
      || (NODE_ENV !== 'production' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error();
  } catch { throw new Error('Invalid APP_ORIGIN: supply one complete trusted origin; production requires HTTPS.'); }
  if (NODE_ENV === 'production' && parsed.data.ALLOW_LOCAL_REGISTRATION) {
    throw new Error('Public production registration is disabled.');
  }
  return { nodeEnv: NODE_ENV, appOrigin: origin, allowLocalRegistration: parsed.data.ALLOW_LOCAL_REGISTRATION };
}

export type AuthConfig = ReturnType<typeof parseAuthConfig>;

// Display capability and HTTP authorization share policy, never client-supplied state.
export function isRegistrationEnabled(config: AuthConfig): boolean {
  return (config.nodeEnv === 'development' || config.nodeEnv === 'test') && config.allowLocalRegistration;
}
