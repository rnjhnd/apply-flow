import type { openFixtureDatabase } from './fixture-database.js';
import type { startFixtureParent } from './fixture-process.js';
import type { Owner } from './ownership.js';
import type { JournalIo } from './journal.js';

// Parent database must be opened only AFTER observed clean child exit. No
// cancellation race or failed teardown is permission to run finalization.
export async function finishFixtureLifecycle(parent: Awaited<ReturnType<typeof startFixtureParent>>, owner: Owner,
  journal: JournalIo, connect: () => Promise<Awaited<ReturnType<typeof openFixtureDatabase>>>) {
  let database: Awaited<ReturnType<typeof openFixtureDatabase>> | undefined;
  try {
    await parent.run(); await parent.stop();
    const finalizer = parent.finalizer();
    database = await connect();
    const permit = await database.finalize(finalizer, owner, journal);
    await database.cleanup(permit);
    await database.close();
    if (!database.isClosed() || finalizer.phase() !== 'cleaned') throw new Error();
    parent.release();
    return Object.freeze({ outcome: 'cleaned' as const });
  } catch {
    parent.review();
    try { await parent.stop(); } catch { /* No substitute for clean exit. */ }
    try { await database?.close(); } catch { /* Retain evidence. */ }
    throw new Error('Fixture lifecycle requires review.');
  }
}
