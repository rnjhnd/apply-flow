import type { ApplicationErrorResponse } from '@applyflow/contracts';

export class ApplicationHttpError extends Error {
  constructor(readonly status: number, readonly code: ApplicationErrorResponse['code'], message: string,
    readonly fieldErrors?: ApplicationErrorResponse['fieldErrors'],
    readonly conflictReason?: ApplicationErrorResponse['conflictReason']) {
    super(message);
    this.name = 'ApplicationHttpError';
  }
}
