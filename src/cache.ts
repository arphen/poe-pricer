import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', '.cache');

const safe = (key: string) => key.replace(/[^a-zA-Z0-9_.-]/g, '_');

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>, force = false): Promise<T> {
  const file = join(dir, `${safe(key)}.json`);
  if (!force) try {
    const { at, value } = JSON.parse(await readFile(file, 'utf8'));
    if (Date.now() - at < ttlMs) return value as T;
  } catch {
    // miss
  }
  const value = await load();
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ at: Date.now(), value }));
  return value;
}
