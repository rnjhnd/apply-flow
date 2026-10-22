import { createContext, useContext } from 'react';

export type AuthAdmission = { allowed: boolean; canSubmit: () => boolean };
export const AuthAdmissionContext = createContext<AuthAdmission | null>(null);

export function useAuthAdmission() {
  const admission = useContext(AuthAdmissionContext);
  if (!admission) throw new Error('Authentication actions require their route boundary.');
  return admission;
}
