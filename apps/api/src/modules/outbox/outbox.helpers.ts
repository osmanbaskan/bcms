import { Prisma } from '@prisma/client';
import { createEnvelope, type OutboxEnvelope } from './outbox.types.js';

/**
 * Madde 2+7 PR-B3b-1: küçük ortak outbox shadow write helper.
 * Madde 2+7 PR-B3b-2 schema PR: opsiyonel idempotencyKey + ON CONFLICT skip.
 *
 * Domain flow seviyesinde ortaklaştırma yapmaz; payload + outbox row write
 * mekaniğini tek noktaya çeker. Watcher ve route kendi $transaction akışlarını
 * koruyarak bu helper'ı çağırır.
 *
 * PR-C2 cut-over (2026-05-11): `OUTBOX_POLLER_AUTHORITATIVE=true` set
 * edildiğinde shadow yazımı status='pending' + publishedAt=null ile gelir.
 * Poller bu satırı pick eder ve authoritative publish yapar; direct publish
 * call site'ları aynı env flag ile skip edilir. Flag unset/false ise
 * Phase 2 shadow davranışı (status='published') korunur — rollback yolu.
 *
 * idempotencyKey verildiğinde:
 * - Format kontrolü: 1..160 char, boş string null-equivalent (insert atılmaz
 *   yerine normal insert yapılır — input "''" anlamlı bir key değil, caller
 *   undefined geçmeli; helper bunu defensive olarak yakalar).
 * - Raw INSERT ... ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
 *   DO NOTHING. Conflict target predicate partial unique index için zorunlu —
 *   PostgreSQL inference'ı predicate'siz olarak partial index'i her zaman seçmez.
 * - Aynı key'le ikinci yazım: tek satır kalır, RETURNING boş döner →
 *   `{ inserted: false, eventId: <var olan> }` (caller telemetri/log için kullanabilir).
 * - Var olan eventId DB'den SELECT ile çekilir; helper duplicate skip durumunda
 *   bile caller'a anlamlı eventId döner.
 *
 * Return: { inserted, eventId }. Mevcut caller'lar return'u kullanmıyorsa
 * await ile çağırmaya devam edebilir; tip darlaşması yok.
 */

type TxClient = Prisma.TransactionClient;

const IDEMPOTENCY_KEY_MAX = 160;

/**
 * PR-C2 cut-over flag. `true` → shadow status='pending' (poller pick eder);
 * `false`/unset → 'published' (Phase 2 shadow, direct publish hâlâ aktif).
 *
 * Service-level direct publish call site'ları aynı flag ile env-gated skip
 * eder; eski Phase 2 davranışı `false`/unset ile geri alınır (rollback).
 */
export function isOutboxPollerAuthoritative(): boolean {
  return (process.env.OUTBOX_POLLER_AUTHORITATIVE ?? '').toLowerCase() === 'true';
}

const isPollerAuthoritative = isOutboxPollerAuthoritative;

export interface ShadowEventInput<P extends Record<string, unknown>> {
  eventType: string;
  aggregateType: string;
  aggregateId: number | string;
  payload: P;
  schemaVersion?: number;
  /**
   * Cross-producer dedup key. Format öneri:
   * `{eventType}:{aggregateType}:{aggregateId}:{discriminator}`. Verilmezse
   * normal insert (random UUID v4 eventId tek başına yeterli idempotency anchor).
   * Boş string undefined-equivalent olarak ele alınır.
   */
  idempotencyKey?: string;
}

export interface ShadowEventResult {
  /** true: yeni satır yazıldı; false: aynı idempotency_key ile zaten var, skip. */
  inserted: boolean;
  /** Yeni satırsa freshly minted UUID; skip ise mevcut satırın eventId'si. */
  eventId: string;
}

export async function writeShadowEvent<P extends Record<string, unknown>>(
  tx: TxClient,
  input: ShadowEventInput<P>,
): Promise<ShadowEventResult> {
  const env = createEnvelope({
    eventType:     input.eventType,
    aggregateType: input.aggregateType,
    aggregateId:   input.aggregateId,
    payload:       input.payload,
    schemaVersion: input.schemaVersion,
  });

  // Boş string defensive null-equivalent. Caller "" geçmemeli; geçtiyse normal
  // insert yolundan git (idempotency tetikleme).
  const rawKey = input.idempotencyKey;
  const key = typeof rawKey === 'string' && rawKey.length > 0 ? rawKey : undefined;

  if (key !== undefined) {
    if (key.length > IDEMPOTENCY_KEY_MAX) {
      throw new Error(
        `idempotencyKey uzunluğu ${IDEMPOTENCY_KEY_MAX} karakteri aşıyor (got ${key.length})`,
      );
    }
    return writeWithIdempotency(tx, env, key);
  }

  const authoritative = isPollerAuthoritative();
  await tx.outboxEvent.create({
    data: {
      eventId:       env.eventId,
      eventType:     env.eventType,
      aggregateType: env.aggregateType,
      aggregateId:   env.aggregateId,
      schemaVersion: env.schemaVersion,
      payload:       env.payload as Prisma.InputJsonValue,
      occurredAt:    new Date(env.occurredAt),
      status:        authoritative ? 'pending' : 'published',
      publishedAt:   authoritative ? null : new Date(),
    },
  });
  return { inserted: true, eventId: env.eventId };
}

/**
 * Raw INSERT with ON CONFLICT predicate matching the partial unique index.
 * RETURNING event_id boş → duplicate; SELECT ile mevcut eventId çek.
 *
 * Payload JSON.stringify + ::jsonb cast — Prisma raw template literal JSONB
 * için type inference yapmaz, explicit cast güvenli ve okunabilir.
 */
async function writeWithIdempotency<P extends Record<string, unknown>>(
  tx: TxClient,
  env: OutboxEnvelope<P>,
  key: string,
): Promise<ShadowEventResult> {
  const now = new Date();
  const authoritative = isPollerAuthoritative();
  const status = authoritative ? 'pending' : 'published';
  const publishedAt = authoritative ? null : now;
  const inserted = await tx.$queryRaw<Array<{ event_id: string }>>`
    INSERT INTO "outbox_events" (
      "event_id", "event_type", "aggregate_type", "aggregate_id",
      "schema_version", "payload", "status", "occurred_at", "published_at",
      "next_attempt_at", "idempotency_key"
    ) VALUES (
      ${env.eventId}, ${env.eventType}, ${env.aggregateType}, ${env.aggregateId},
      ${env.schemaVersion}, ${JSON.stringify(env.payload)}::jsonb, ${status},
      ${new Date(env.occurredAt)}, ${publishedAt}, ${now}, ${key}
    )
    ON CONFLICT ("idempotency_key") WHERE "idempotency_key" IS NOT NULL DO NOTHING
    RETURNING "event_id"
  `;

  if (inserted.length > 0) {
    return { inserted: true, eventId: inserted[0].event_id };
  }

  // Duplicate skip: mevcut satırın eventId'sini döndür (caller telemetri/log).
  const existing = await tx.$queryRaw<Array<{ event_id: string }>>`
    SELECT "event_id" FROM "outbox_events" WHERE "idempotency_key" = ${key}
  `;
  // Defensive: row yoksa beklenmeyen state (concurrent DELETE?). Yine de yeni
  // eventId döner ki caller bir UUID alsın; inserted=false sinyali asıl bilgi.
  const eventId = existing.length > 0 ? existing[0].event_id : env.eventId;
  return { inserted: false, eventId };
}
