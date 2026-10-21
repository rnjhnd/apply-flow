import { useState, type ReactNode } from 'react';
import { getAuthStore, type AuthStore } from '../../lib/auth/store';
import { AuthContext, createAuthIntegration } from './use-auth';

export function AuthProvider({ store, children }: { store?: AuthStore | undefined; children: ReactNode }) {
  const [integration] = useState(() => createAuthIntegration(store ?? getAuthStore()));
  // React cleanup only unsubscribes observers; the document's auth singleton owns its lifecycle.
  return <AuthContext value={integration}>{children}</AuthContext>;
}
