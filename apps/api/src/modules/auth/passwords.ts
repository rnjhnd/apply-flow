import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { loginPasswordSchema, registrationPasswordSchema } from '@applyflow/contracts';

export const ARGON2_PARAMETERS = Object.freeze({ type: argon2.argon2id, memoryCost: 65_536,
  timeCost: 3, parallelism: 1, hashLength: 32, version: 0x13 });

export class PasswordOperationError extends Error {
  constructor(public readonly code: 'BUSY' | 'UNAVAILABLE' | 'INVALID_PASSWORD') {
    super(code === 'BUSY' ? 'Password service is busy.' : code === 'INVALID_PASSWORD'
      ? 'Password does not meet the input requirements.' : 'Password service is unavailable.');
    this.name = 'PasswordOperationError';
  }
}

type PasswordBackend = {
  hash: (password: string, options: argon2.HashOptions) => Promise<string>;
  verify: (digest: string, password: string) => Promise<boolean>;
};

function approvedDigest(digest: string): boolean {
  const match = /^\$argon2id\$v=19\$([^$]{1,64})\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.exec(digest);
  if (!match) return false;
  const parameters = match[1]!.split(',');
  return parameters.length === 3 && new Set(parameters).size === 3
    && parameters.every((parameter) => ['m=65536', 't=3', 'p=1'].includes(parameter));
}

export async function createPasswordService(backend: PasswordBackend = argon2) {
  let active = 0;
  async function admitted<T>(work: () => Promise<T>): Promise<T> {
    if (active >= 2) throw new PasswordOperationError('BUSY');
    active++;
    try { return await work(); }
    catch { throw new PasswordOperationError('UNAVAILABLE'); }
    finally { active--; }
  }
  const hash = (password: string) => admitted(() => backend.hash(password, {
    ...ARGON2_PARAMETERS, salt: randomBytes(16)
  }));
  const dummyHash = await hash(randomBytes(32).toString('hex'));

  return {
    async hash(password: string): Promise<string> {
      if (!registrationPasswordSchema.safeParse(password).success) throw new PasswordOperationError('INVALID_PASSWORD');
      return hash(password);
    },
    async verify(digest: string | null, password: string): Promise<boolean> {
      if (!loginPasswordSchema.safeParse(password).success) throw new PasswordOperationError('INVALID_PASSWORD');
      const selected = digest ?? dummyHash;
      // Only this approved PHC profile is accepted; corrupt database values cannot request unbounded work.
      if (!approvedDigest(selected)) {
        throw new PasswordOperationError('UNAVAILABLE');
      }
      return admitted(async () => {
        const valid = await backend.verify(selected, password);
        return digest !== null && valid;
      });
    }
  };
}
