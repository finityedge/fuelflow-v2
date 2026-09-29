import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';

const TENANT_SCOPED_MODELS = ['Station', 'User', 'ShiftReport', 'ExtractedField'] as const;

type TenantScopedModel = (typeof TENANT_SCOPED_MODELS)[number];

export const tenantContext = new AsyncLocalStorage<{ tenantId: string } | undefined>();

function getTenantId(): string | undefined {
  return tenantContext.getStore()?.tenantId;
}

const basePrisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

function injectTenantWhere(
  args: Record<string, unknown> | undefined,
  tenantId: string
): Record<string, unknown> {
  if (!args) {
    return { where: { tenantId } };
  }

  const existingWhere = args.where as Record<string, unknown> | undefined;
  if (!existingWhere) {
    return { ...args, where: { tenantId } };
  }

  return {
    ...args,
    where: {
      AND: [existingWhere, { tenantId }],
    },
  };
}

/**
 * The same idea as `injectTenantWhere`, for the two operations whose `where` is a
 * `WhereUniqueInput`: `update` and `delete`.
 *
 * Those reject the `AND` wrapper, because a `WhereUniqueInput` requires a unique field
 * (`id`) at the *top level* of the filter, and `AND: [{ id }, { tenantId }]` hides it
 * inside the array. Prisma then fails validation with "needs at least one of `id`
 * arguments". So for these two the tenant filter is merged flat, leaving `id` where the
 * unique-fields input expects it — Prisma accepts the extra `tenantId` alongside it.
 */
function injectTenantIntoUniqueWhere(
  args: Record<string, unknown> | undefined,
  tenantId: string
): Record<string, unknown> {
  const where = (args?.where as Record<string, unknown> | undefined) ?? {};
  return { ...args, where: { ...where, tenantId } };
}

function injectTenantCreate(
  args: Record<string, unknown> | undefined,
  tenantId: string
): Record<string, unknown> {
  if (!args) {
    return { data: { tenantId } };
  }

  const data = args.data as Record<string, unknown> | Record<string, unknown>[] | undefined;
  if (Array.isArray(data)) {
    return { ...args, data: data.map((item) => ({ ...item, tenantId })) };
  }

  return { ...args, data: { ...(data ?? {}), tenantId } };
}

function isScopedModel(model: string): model is TenantScopedModel {
  return (TENANT_SCOPED_MODELS as readonly string[]).includes(model);
}

export const prisma = basePrisma.$extends({
  query: {
    $allModels: {
      async findUnique({ model, args, query }) {
        const tenantId = getTenantId();
        if (!tenantId || !isScopedModel(model)) {
          return query(args as never);
        }
        return query({ ...(args as Record<string, unknown>), where: { ...(args as { where: Record<string, unknown> }).where, tenantId } } as never);
      },
      async findUniqueOrThrow({ model, args, query }) {
        const tenantId = getTenantId();
        if (!tenantId || !isScopedModel(model)) {
          return query(args as never);
        }
        return query({ ...(args as Record<string, unknown>), where: { ...(args as { where: Record<string, unknown> }).where, tenantId } } as never);
      },
      async findFirst({ model, args, query }) {
        const tenantId = getTenantId();
        if (!tenantId || !isScopedModel(model)) {
          return query(args as never);
        }
        return query(injectTenantWhere(args as Record<string, unknown>, tenantId) as never);
      },
      async findFirstOrThrow({ model, args, query }) {
        const tenantId = getTenantId();
        if (!tenantId || !isScopedModel(model)) {
          return query(args as never);
        }
        return query(injectTenantWhere(args as Record<string, unknown>, tenantId) as never);
      },
      async findMany({ model, args, query }) {
        const tenantId = getTenantId();
        if (!tenantId || !isScopedModel(model)) {
          return query(args as never);
        }
        return query(injectTenantWhere(args as Record<string, unknown>, tenantId) as never);
      },
      async count({ model, args, query }) {
        const tenantId = getTenantId();
        if (!tenantId || !isScopedModel(model)) {
          return query(args as never);
        }
        return query(injectTenantWhere(args as Record<string, unknown>, tenantId) as never);
      },
      async aggregate({ model, args, query }) {
        const tenantId = getTenantId();
        if (!tenantId || !isScopedModel(model)) {
          return query(args as never);
        }
        return query(injectTenantWhere(args as Record<string, unknown>, tenantId) as never);
      },
      async groupBy({ model, args, query }) {
        const tenantId = getTenantId();
        if (!tenantId || !isScopedModel(model)) {
          return query(args as never);
        }
        return query(injectTenantWhere(args as Record<string, unknown>, tenantId) as never);
      },
      async create({ model, args, query }) {
        const tenantId = getTenantId();
        if (!tenantId || !isScopedModel(model)) {
          return query(args as never);
        }
        return query(injectTenantCreate(args as Record<string, unknown>, tenantId) as never);
      },
      async createMany({ model, args, query }) {
        const tenantId = getTenantId();
        if (!tenantId || !isScopedModel(model)) {
          return query(args as never);
        }
        return query(injectTenantCreate(args as Record<string, unknown>, tenantId) as never);
      },
      async update({ model, args, query }) {
        const tenantId = getTenantId();
        if (!tenantId || !isScopedModel(model)) {
          return query(args as never);
        }
        return query(injectTenantIntoUniqueWhere(args as Record<string, unknown>, tenantId) as never);
      },
      async updateMany({ model, args, query }) {
        const tenantId = getTenantId();
        if (!tenantId || !isScopedModel(model)) {
          return query(args as never);
        }
        return query(injectTenantWhere(args as Record<string, unknown>, tenantId) as never);
      },
      async delete({ model, args, query }) {
        const tenantId = getTenantId();
        if (!tenantId || !isScopedModel(model)) {
          return query(args as never);
        }
        return query(injectTenantIntoUniqueWhere(args as Record<string, unknown>, tenantId) as never);
      },
      async deleteMany({ model, args, query }) {
        const tenantId = getTenantId();
        if (!tenantId || !isScopedModel(model)) {
          return query(args as never);
        }
        return query(injectTenantWhere(args as Record<string, unknown>, tenantId) as never);
      },
      async upsert({ model, args, query }) {
        const tenantId = getTenantId();
        if (!tenantId || !isScopedModel(model)) {
          return query(args as never);
        }
        return query({
          ...(injectTenantIntoUniqueWhere(args as Record<string, unknown>, tenantId) as {
            create: Record<string, unknown>;
          }),
          create: {
            ...((args as { create: Record<string, unknown> }).create),
            tenantId,
          },
        } as never);
      },
    },
  },
});

export async function withTenantScope<T>(tenantId: string, fn: () => Promise<T> | T): Promise<T> {
  return tenantContext.run({ tenantId }, async () => fn());
}
