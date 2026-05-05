import { randomUUID } from 'node:crypto';

/**
 * Madde 2+7 PR-A (audit doc): Outbox event envelope types + helper.
 *
 * Tasarım: ops/REQUIREMENTS-OUTBOX-DLQ-V1.md §3 (Event envelope standardı)
 *
 * Notlar:
 * - eventId: UUID v4 (crypto.randomUUID()); idempotency anchor.
 * - schemaVersion: payload field eklenirse +1; consumer eski version'ları
 *   graceful handle.
 * - **Payload object convention**: helper object payload yazar; DB sadece
 *   JSONB type-check eder, non-object (string/number) bloklamaz. Caller
 *   bu helper'ı kullanmalı.
 *
 * PR-A scope sadece foundation. Service refactor (transactional outbox write)
 * PR-B kapsamı; poller (publish behavior) PR-C kapsamı.
 */

export type OutboxEventStatus = 'pending' | 'published' | 'failed' | 'dead';

export interface OutboxEnvelope<P extends Record<string, unknown> = Record<string, unknown>> {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  schemaVersion: number;
  occurredAt: string; // ISO 8601 UTC
  payload: P;
}

export interface CreateEnvelopeOptions<P extends Record<string, unknown>> {
  eventType: string;
  aggregateType: string;
  aggregateId: string | number;
  payload: P;
  schemaVersion?: number;
}

/**
 * Envelope factory; her çağrı yeni eventId (UUID v4) ve şu anki occurredAt verir.
 * Service'ler bu helper'ı kullanır (PR-B), service.ts'te inline obje hazırlamak yerine.
 */
export function createEnvelope<P extends Record<string, unknown>>(
  opts: CreateEnvelopeOptions<P>,
): OutboxEnvelope<P> {
  return {
    eventId:       randomUUID(),
    eventType:     opts.eventType,
    aggregateType: opts.aggregateType,
    aggregateId:   String(opts.aggregateId),
    schemaVersion: opts.schemaVersion ?? 1,
    occurredAt:    new Date().toISOString(),
    payload:       opts.payload,
  };
}

/** UUID v4 simple regex (lowercase hex, 4xxx variant). */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidEventId(eventId: string): boolean {
  return UUID_V4_RE.test(eventId);
}
