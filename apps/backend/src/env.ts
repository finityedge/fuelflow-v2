/**
 * Loads `.env` for processes started outside Docker.
 *
 * `import 'dotenv/config'` reads `.env` from the current working directory and nowhere
 * else. That is the wrong directory here: pnpm runs a workspace script with the cwd set to
 * the package, so `pnpm db:seed` from the repo root loads `apps/backend/.env`, which does
 * not exist — and the only `.env` in this repo is at the root. The failure is not "no
 * .env", which would be obvious; it is
 *
 *   error: Environment variable not found: DATABASE_URL
 *
 * from Prisma, or a connection attempt to the fallback address, which reads like a bad
 * connection string rather than a missing file.
 *
 * So search upward from the cwd instead, nearest file first: `apps/backend/.env` if
 * someone keeps one, otherwise the repo root's. In Docker nothing is found — `.env` is in
 * .dockerignore — and the values come from the compose `environment:` blocks, which is
 * what should win. `dotenv` does not overwrite variables that are already set, so the
 * container's DATABASE_URL is never replaced by a file even if one does turn up.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import dotenv from 'dotenv';

/** How many parent directories to climb. The repo root is 2 up from apps/backend. */
const MAX_DEPTH = 6;

function findEnvFile(): string | undefined {
  let dir = process.cwd();

  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);
    // Reached the filesystem root: `dirname` stops changing, so stop climbing.
    if (parent === dir) break;
    dir = parent;
  }

  return undefined;
}

const envFile = findEnvFile();

if (envFile) {
  dotenv.config({ path: envFile });
}
