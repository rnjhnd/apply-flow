import type { AuthErrorResponse } from '@applyflow/contracts';

export class AuthHttpError extends Error {
  constructor(public readonly status: number, public readonly code: AuthErrorResponse['code'],
    message: string, public readonly retryAfter?: number, public readonly fieldErrors?: AuthErrorResponse['fieldErrors']) {
    super(message);
    this.name = 'AuthHttpError';
  }
}
