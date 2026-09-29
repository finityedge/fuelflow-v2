import 'dotenv/config';
import { prisma } from '../../src/prisma/client.js';

async function main() {
  const count = await prisma.user.count();
  console.log('user count', count);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
}).finally(() => prisma.$disconnect());
