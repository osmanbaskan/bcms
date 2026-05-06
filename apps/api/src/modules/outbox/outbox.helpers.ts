import { Prisma } from '@prisma/client';
import { createEnvelope, type OutboxEnvelope } from './outbox.types.js';

/**
 * Madde 2+7 PR-B3b-1: küçük ortak outbox shadow write helper.
 *
 * Domain flow seviyesinde ortaklaştırma yapmaz; payload + outbox row write
 * mekaniğini tek noktaya çeker. Watcher ve route kendi $transaction akışlarını
 * koruyarak bu helper'ı çağırır.
 *
 * status='published' + publishedAt=now() ile yazılır (Phase 2 shadow):
 * direct publish hâlâ aktif, outbox satırı yalnız tarihçe.
 */

type TxClient = Prisma.TransactionClient;

export interface ShadowEventInput<P extends Record<string, unknown>> {
  eventType: string;
  aggregateType: string;
  aggregateId: number | string;
  payload: P;
  schemaVersion?: number;
}

export async function writeShadowEvent<P extends Record<string, unknown>>(
  tx: TxClient,
  input: ShadowEventInput<P>,
): Promise<OutboxEnvelope<P>> {
  const env = createEnvelope({
    eventType:     input.eventType,
    aggregateType: input.aggregateType,
    aggregateId:   input.aggregateId,
    payload:       input.payload,
    schemaVersion: input.schemaVersion,
  });
  await tx.outboxEvent.create({
    data: {
      eventId:       env.eventId,
      eventType:     env.eventType,
      aggregateType: env.aggregateType,
      aggregateId:   env.aggregateId,
      schemaVersion: env.schemaVersion,
      payload:       env.payload as Prisma.InputJsonValue,
      occurredAt:    new Date(env.occurredAt),
      status:        'published',
      publishedAt:   new Date(),
    },
  });
  return env;
}
