import type { ApplicationDraft } from './use-applications';

export const applicationFields = ['company', 'jobTitle', 'status', 'applicationDate', 'location', 'jobUrl', 'notes'] as const;
export const applicationLabels = { company: 'Company', jobTitle: 'Job title', status: 'Status', applicationDate: 'Application date',
  location: 'Location', jobUrl: 'Job URL', notes: 'Notes' };
export type ApplicationFieldErrors = Partial<Record<keyof ApplicationDraft, string>>;
export const statusLabel = (status: string) => status.charAt(0) + status.slice(1).toLowerCase();
