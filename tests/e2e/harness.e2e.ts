import { test } from './support/fixtures.js';

// Discovery sentinel, not an implemented/passing browser authentication test.
// The automatic boundary deliberately rejects execution until Stage 2C.3B.
test('guarded compiled-application runtime (Stage 2C.3B required)', () => {
  throw new Error('A guarded live runtime must replace the offline boundary before browser scenarios are added.');
});
