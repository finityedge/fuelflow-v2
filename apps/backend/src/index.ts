import './env.js';
import { buildApp } from './app.js';

async function main() {
  const app = await buildApp();
  const port = Number(process.env.PORT || 3000);

  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`Server listening on http://0.0.0.0:${port}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
