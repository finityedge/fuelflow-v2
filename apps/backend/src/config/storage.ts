/**
 * Where uploaded PDFs live.
 *
 * Files are addressed by a relative key (`<tenantId>/<reportId>.pdf`) recorded on the
 * ShiftReport row, so nothing in the database carries an absolute path and the storage
 * root can be moved without a migration.
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function resolveStorageDir(): string {
  return path.resolve(process.env.STORAGE_DIR ?? './storage/pdfs');
}

/**
 * Resolve a stored key to an absolute path, refusing anything that would escape the
 * storage root. The key comes from our own database, but a path that can climb out of
 * its directory is not worth trusting to that.
 */
export function storagePathFor(key: string): string {
  const root = resolveStorageDir();
  const resolved = path.resolve(root, key);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to access a path outside the storage directory: ${key}`);
  }
  return resolved;
}

export async function savePdf(key: string, data: Buffer): Promise<void> {
  const target = storagePathFor(key);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data);
}

export async function readPdf(key: string): Promise<Buffer> {
  return readFile(storagePathFor(key));
}

/** Best-effort cleanup. A missing file is not an error worth surfacing. */
export async function deletePdf(key: string): Promise<void> {
  try {
    await unlink(storagePathFor(key));
  } catch {
    // already gone
  }
}
