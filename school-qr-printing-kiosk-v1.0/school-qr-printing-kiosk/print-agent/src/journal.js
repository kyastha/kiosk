import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export function attemptMarker(attemptId) {
  const hash = createHash('sha256').update(attemptId).digest('hex');
  return 'kiosk-' + hash.slice(0, 32);
}

export async function openJournal(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = attemptId => join(directory, attemptMarker(attemptId) + '.json');
  return {
    async read(attemptId) {
      try {
        return JSON.parse(await readFile(path(attemptId), 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
      }
    },
    async write(attemptId, record) {
      const target = path(attemptId);
      const temporary = target + '.' + randomUUID() + '.tmp';
      try {
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify(record));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, target);
        if (process.platform !== 'win32') {
          const parent = await open(directory, 'r');
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
        }
      } finally {
        await rm(temporary, { force: true });
      }
    },
    async remove(attemptId) {
      await rm(path(attemptId), { force: true });
    }
  };
}
