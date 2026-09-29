/**
 * The parsing worker.
 *
 * A separate process from the API on purpose: parsing a PDF is CPU-bound and can take
 * seconds, and the API is what a manager's phone is waiting on. Running them in one
 * process would make a slow parse look like a slow upload.
 */

import './env.js';
import { Worker } from 'bullmq';
import { createRedisConnection } from './config/redis.js';
import { PDF_PARSE_QUEUE } from './jobs/queues.js';
import { pdfProcessor } from './jobs/processors/pdfProcessor.js';

async function main() {
  const worker = new Worker(PDF_PARSE_QUEUE, pdfProcessor, {
    connection: createRedisConnection(),
    // Parsing is CPU-bound, so a small concurrency beats thrashing the event loop.
    concurrency: Number(process.env.PARSE_CONCURRENCY ?? 2),
  });

  worker.on('completed', (job) => {
    console.log(`[pdf-parse] completed job ${job.id}`, job.returnvalue);
  });

  worker.on('failed', (job, error) => {
    console.error(`[pdf-parse] job ${job?.id} failed:`, error.message);
  });

  const shutdown = async () => {
    await worker.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`[pdf-parse] worker listening on queue "${PDF_PARSE_QUEUE}"`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
