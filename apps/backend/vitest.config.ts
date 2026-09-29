import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 15000,
    setupFiles: ['./tests/setup.ts'],
    // A test run is not a dev server. Without this the Prisma client logs every query it
    // makes, which buries the assertions under hundreds of lines of SQL. dotenv does not
    // override variables that are already set, so this wins over the root .env.
    env: { NODE_ENV: 'test' },
    // Every suite here shares one PostgreSQL database, and several reset it wholesale in
    // `beforeAll` (`prisma.tenant.deleteMany()` with no filter). Run in parallel, one
    // file's reset deletes another file's fixtures mid-test. Serial execution is the fix;
    // the alternative is per-suite databases, which is more machinery than this earns.
    fileParallelism: false,
  },
});
