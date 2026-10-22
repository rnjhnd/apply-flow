import { applicationDateSchema } from '@applyflow/contracts';
import { parseEnv } from '../../config/env.js';

export type ApplicationDateResult = { valid: true } | { valid: false; field: 'applicationDate'; message: string };

// No environment reads and no implicit clock. Configuration validation is shared
// with the application; the caller passes its validated APP_TIMEZONE when wiring services.
export function createApplicationDatePolicy(options: { now: () => Date; timeZone?: string }) {
  const { APP_TIMEZONE } = parseEnv(options.timeZone === undefined ? {} : { APP_TIMEZONE: options.timeZone });
  const formatter = new Intl.DateTimeFormat('en', {
    timeZone: APP_TIMEZONE, calendar: 'gregory', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return (applicationDate: string | null): ApplicationDateResult => {
    if (applicationDate === null) return { valid: true };
    const parsed = applicationDateSchema.safeParse(applicationDate);
    if (!parsed.success) return { valid: false, field: 'applicationDate', message: 'Use a real YYYY-MM-DD calendar date' };
    const instant = options.now();
    if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw new Error('Invalid application clock.');
    const parts = formatter.formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value;
    const year = part('year');
    if (!year || parts.some((value) => value.type === 'era') || Number(year) > 9999 || Number(year) < 1
      || instant.getUTCFullYear() < 1) throw new Error('Invalid application clock.');
    const today = `${year.padStart(4, '0')}-${part('month')}-${part('day')}`;
    return applicationDate <= today ? { valid: true }
      : { valid: false, field: 'applicationDate', message: 'Application date cannot be in the future' };
  };
}
