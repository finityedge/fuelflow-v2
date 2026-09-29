import '../src/env.js';
import { UserRole } from '@fuelflow/shared';
import { prisma } from '../src/prisma/client.js';
import { hashPassword } from '../src/services/password.service.js';

async function main() {
  const password = await hashPassword('password');

  const tenant = await prisma.tenant.upsert({
    where: { id: 'demo-tenant' },
    update: {},
    create: {
      id: 'demo-tenant',
      name: 'Demo Fuel Station',
    },
  });

  const station = await prisma.station.upsert({
    where: { id: 'demo-station' },
    update: {},
    create: {
      id: 'demo-station',
      tenantId: tenant.id,
      name: 'Main Station',
      location: 'Dar es Salaam',
    },
  });

  const owner = await prisma.user.upsert({
    where: { email: 'owner@fuelflow.local' },
    update: {},
    create: {
      tenantId: tenant.id,
      email: 'owner@fuelflow.local',
      passwordHash: password,
      role: UserRole.OWNER,
    },
  });

  const manager = await prisma.user.upsert({
    where: { email: 'manager@fuelflow.local' },
    update: {},
    create: {
      tenantId: tenant.id,
      email: 'manager@fuelflow.local',
      passwordHash: password,
      role: UserRole.MANAGER,
    },
  });

  await prisma.stationAssignment.upsert({
    where: {
      userId_stationId: {
        userId: manager.id,
        stationId: station.id,
      },
    },
    update: {},
    create: {
      userId: manager.id,
      stationId: station.id,
    },
  });

  console.log('Seeded:', {
    tenant: tenant.name,
    station: station.name,
    owner: owner.email,
    manager: manager.email,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
