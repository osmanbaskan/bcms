import { QUEUES, type QueueName } from '../../plugins/rabbitmq.js';

/**
 * Madde 2+7 PR-C1 (audit doc): outbox event_type → RabbitMQ queue routing.
 *
 * Mevcut direct publish noktalarındaki queue ile bire bir map. Phase 3 cut-over'da
 * poller bu mapping'i kullanarak `outbox_events.payload`'ı ilgili queue'ya
 * publish eder. Payload shape direct publish'in mevcut payload'ı ile aynı
 * (downstream consumer davranışı değişmez).
 *
 * Yeni event_type eklendiğinde bu map'e satır ekleyin; eksik eventType
 * resolveOutboxQueue() Error fırlatır (poller event'i `failed` state'ine
 * düşürür, alarm üretir).
 */
const EVENT_TYPE_TO_QUEUE: Record<string, QueueName> = {
  'schedule.created':              QUEUES.SCHEDULE_CREATED,
  'schedule.updated':              QUEUES.SCHEDULE_UPDATED,
  'booking.created':               QUEUES.BOOKING_CREATED,
  'notification.email_requested':  QUEUES.NOTIFICATIONS_EMAIL,
  'ingest.job_started':            QUEUES.INGEST_NEW,
  'ingest.job_completed':          QUEUES.INGEST_COMPLETED,
};

export function resolveOutboxQueue(eventType: string): QueueName {
  const queue = EVENT_TYPE_TO_QUEUE[eventType];
  if (!queue) {
    throw new Error(
      `Outbox event_type='${eventType}' için queue routing tanımlı değil; ` +
      `outbox.routing.ts'e satır ekleyin.`,
    );
  }
  return queue;
}

export const KNOWN_OUTBOX_EVENT_TYPES = Object.freeze(
  Object.keys(EVENT_TYPE_TO_QUEUE),
) as readonly string[];
