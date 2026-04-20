import { Prisma } from '@prisma/client';

export function asPrismaJson(value: unknown): Prisma.InputJsonValue | undefined {
  return value === undefined ? undefined : value as Prisma.InputJsonValue;
}
