import { z } from 'zod';

export const normalizedEmailSchema = z.string().trim().toLowerCase().max(254)
  .regex(/^[\x20-\x7e]+$/, 'Use an ASCII email address').pipe(z.email());

function passwordSchema(minimum: number) {
  return z.string().max(256).refine((value) => {
    const characters = Array.from(value);
    return characters.length >= minimum && characters.length <= 128
      && characters.every((character) => {
        const code = character.codePointAt(0)!;
        return code < 0xd800 || code > 0xdfff;
      });
  }, `Use ${minimum}–128 Unicode characters without malformed surrogate characters`);
}

export const registrationPasswordSchema = passwordSchema(15);
export const loginPasswordSchema = passwordSchema(1);
export const registerRequestSchema = z.strictObject({ email: normalizedEmailSchema, password: registrationPasswordSchema });
export const loginRequestSchema = z.strictObject({ email: normalizedEmailSchema, password: loginPasswordSchema });
export const logoutRequestSchema = z.preprocess((value) => value === undefined ? {} : value, z.strictObject({}));
export const csrfTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const authUserSchema = z.strictObject({ id: z.uuid(), email: normalizedEmailSchema });
export const csrfResponseSchema = z.strictObject({ csrfToken: csrfTokenSchema, registrationEnabled: z.boolean() });
export const authenticatedResponseSchema = z.strictObject({ user: authUserSchema, csrfToken: csrfTokenSchema });
export const meResponseSchema = z.strictObject({ user: authUserSchema });
export const authErrorResponseSchema = z.strictObject({
  code: z.enum(['INVALID_REQUEST', 'UNAUTHENTICATED', 'INVALID_CREDENTIALS', 'REQUEST_REJECTED',
    'NOT_FOUND', 'ACCOUNT_UNAVAILABLE', 'SESSION_CHANGED', 'ALREADY_AUTHENTICATED',
    'RATE_LIMITED', 'SERVICE_UNAVAILABLE', 'INTERNAL_ERROR', 'INVALID_JSON', 'BODY_TOO_LARGE', 'UNSUPPORTED_ENCODING', 'INVALID_COOKIE']),
  message: z.string(),
  fieldErrors: z.strictObject({ email: z.array(z.string()).optional(), password: z.array(z.string()).optional() }).optional()
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;
export type AuthUser = z.infer<typeof authUserSchema>;
export type AuthenticatedResponse = z.infer<typeof authenticatedResponseSchema>;
export type CsrfResponse = z.infer<typeof csrfResponseSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type AuthErrorResponse = z.infer<typeof authErrorResponseSchema>;
