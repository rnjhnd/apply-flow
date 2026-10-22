import type { DatabaseEnvironment, LocalDatabaseTarget } from '../../../apps/api/src/config/database.js';
import { parseAuthConfig, type AuthConfig } from '../../../apps/api/src/config/auth.js';
import { connectGuarded, type DatabaseInspection } from './guarded-database.js';
import { bindLoopback, type LoopbackListener } from './lifecycle.js';
import type { createChildRecorder } from './child-protocol.js';

type Connection = { inspect(): Promise<DatabaseInspection>; close(): Promise<void> };
type Listener = LoopbackListener & { close(): Promise<void> };
// Inert composition, with no default connector, HTTP listener, or application
// import. The future listener must reject traffic until attach completes.
export async function composeChild<C extends Connection>(source: DatabaseEnvironment, sql: Uint8Array,
  recorder: ReturnType<typeof createChildRecorder>, dependencies: {
    connect(target: LocalDatabaseTarget): Promise<C>;
    listener(): Listener;
    attach(connection: C, listener: Listener, config: AuthConfig, options: { serveFrontend: true }): Promise<void>;
    review(): void;
  }) {
  const connection = await connectGuarded(source, sql, dependencies.connect);
  let listener: Listener | undefined;
  try {
    listener = dependencies.listener(); const activeListener = listener;
    const origin = await bindLoopback(activeListener);
    const config = parseAuthConfig({ NODE_ENV: 'test', APP_ORIGIN: origin, ALLOW_LOCAL_REGISTRATION: 'true' });
    await dependencies.attach(connection, activeListener, config, { serveFrontend: true });
    let shutdown: ReturnType<typeof recorder.seal> | undefined;
    return { origin, config,
      stop() {
        shutdown ??= recorder.seal(async () => { await activeListener.close(); await connection.close(); });
        return shutdown;
      }
    };
  } catch {
    dependencies.review();
    try { await listener?.close(); } catch { /* No exit/cleanup authorization. */ }
    try { await connection.close(); } catch { /* Retain evidence for review. */ }
    throw new Error('Child composition requires review.');
  }
}
