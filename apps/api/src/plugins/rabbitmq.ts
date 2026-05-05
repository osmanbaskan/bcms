import fp from 'fastify-plugin';
import amqplib, { type ConfirmChannel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import type { FastifyInstance } from 'fastify';

// ── Queue / Exchange definitions ──────────────────────────────────────────────
// Reserved event docs: infra/architecture/event-bus.md
export const QUEUES = {
  SCHEDULE_CREATED:   'queue.schedule.created',
  SCHEDULE_UPDATED:   'queue.schedule.updated',
  BOOKING_CREATED:    'queue.booking.created',
  INGEST_NEW:         'queue.ingest.new',
  INGEST_COMPLETED:   'queue.ingest.completed',
  NOTIFICATIONS_EMAIL:'queue.notifications.email',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface RabbitMQClient {
  publish<T>(queue: QueueName, payload: T): Promise<void>;
  consume<T>(queue: QueueName, handler: (payload: T) => Promise<void>): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    rabbitmq: RabbitMQClient;
  }
}

interface ConsumerRecord<T = unknown> {
  queue: QueueName;
  handler: (payload: T) => Promise<void>;
}

// ÖNEMLİ-API-1.1.15 fix (2026-05-04): basit retry policy.
// nack(msg, false, false) eski hâl: requeue=false ve DLX yok → mesaj
// sessiz drop. DLQ tasarımı tasarım onayı gerektirdiği için (queue
// topology değişikliği) interim çözüm: ilk hatada requeue=true (bir
// kez yeniden teslim et), redelivered=true ise drop+log. Email retry
// kendi içinde 3 attempt yapıyor (notification.consumer.ts) — bu
// katman onun üzerinde sadece infrastructure-level retry.
// Tam DLQ + max-retry-count + DLX → ops/REQUIREMENTS-NOTIFICATION-DELIVERY.md
const MAX_PARSE_BYTES = 1 * 1024 * 1024; // 1MB JSON cap (1.1.17)

async function createRabbitMQClient(url: string, logger: FastifyInstance['log']): Promise<RabbitMQClient> {
  let connection: ChannelModel;
  let channel: ConfirmChannel;
  let connected = false;
  let closing = false;
  let connecting = false;        // ORTA-API-1.1.18: race koruması
  // ÖNEMLİ-API-1.1.16 fix (2026-05-04): tek consumer record yerine queue
  // başına consumer ARRAY. Aynı queue'ya iki kez consume() çağrılırsa
  // ikincisi birinciyi silmiyor — her ikisi de register kalıyor.
  const consumers = new Map<QueueName, ConsumerRecord[]>();

  const setupChannel = async () => {
    // ConfirmChannel: sendToQueue callback'i broker ack'inden sonra çağırır.
    // Plain channel'da mesaj sessizce düşebilir (channel buffer dolu / kapalı).
    channel = await connection.createConfirmChannel();
    for (const queue of Object.values(QUEUES)) {
      await channel.assertQueue(queue, { durable: true });
    }
  };

  const attachEventHandlers = () => {
    connection.on('error', (err) => {
      connected = false;
      logger.error({ err }, 'RabbitMQ connection error');
    });

    connection.on('close', () => {
      connected = false;
      if (closing) return;
      logger.warn('RabbitMQ connection closed, reconnecting...');
      scheduleReconnect();
    });
  };

  const connectWithBackoff = async (): Promise<void> => {
    // ORTA-API-1.1.18 fix (2026-05-04): initial + scheduleReconnect race
    // koruması. İki çağrı aynı anda execute edilemez.
    if (connecting) {
      logger.debug('RabbitMQ reconnect already in progress, skipping duplicate trigger');
      return;
    }
    connecting = true;
    try {
      let attempt = 0;
      while (!closing) {
        attempt++;
        try {
          connection = await amqplib.connect(url);
          await setupChannel();
          attachEventHandlers();
          connected = true;
          logger.info('RabbitMQ connected');

          // Re-register existing consumers after reconnect
          for (const records of consumers.values()) {
            for (const record of records) {
              await startConsumer(record.queue, record.handler as (payload: unknown) => Promise<void>);
            }
          }
          return;
        } catch (err) {
          logger.warn({ attempt, err }, 'RabbitMQ connection failed, retrying...');
          const delay = Math.min(3000 * attempt, 30000);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    } finally {
      connecting = false;
    }
  };

  const scheduleReconnect = () => {
    setTimeout(() => {
      connectWithBackoff().catch((err) => {
        logger.error({ err }, 'RabbitMQ reconnect loop failed permanently');
      });
    }, 5000);
  };

  const startConsumer = async <T>(queue: QueueName, handler: (payload: T) => Promise<void>) => {
    await channel.consume(queue, async (msg: ConsumeMessage | null) => {
      if (!msg) return;

      // ORTA-API-1.1.17 fix (2026-05-04): JSON.parse size cap.
      if (msg.content.byteLength > MAX_PARSE_BYTES) {
        logger.error({ queue, bytes: msg.content.byteLength }, 'RabbitMQ message size cap aşıldı (1MB) — drop');
        channel.nack(msg, false, false);
        return;
      }

      let payload: T;
      try {
        payload = JSON.parse(msg.content.toString()) as T;
      } catch (parseErr) {
        // Parse fail — payload bozuk, requeue anlamlı değil.
        logger.error({ queue, err: parseErr }, 'RabbitMQ message JSON parse hatası — drop');
        channel.nack(msg, false, false);
        return;
      }

      try {
        await handler(payload);
        channel.ack(msg);
      } catch (err) {
        // ÖNEMLİ-API-1.1.15 fix (2026-05-04): redelivered=false → bir kez
        // requeue ver (transient error olabilir); zaten redelivered=true ise
        // drop. DLQ implementasyonu için ops/REQUIREMENTS-NOTIFICATION-DELIVERY.
        if (!msg.fields.redelivered) {
          logger.warn({ err, queue }, 'Consumer error — bir kez requeue ediliyor');
          channel.nack(msg, false, true);
        } else {
          logger.error({ err, queue }, 'Consumer error (redelivered) — drop');
          channel.nack(msg, false, false);
        }
      }
    });
  };

  await connectWithBackoff();

  return {
    isConnected: () => connected,
    async publish<T>(queue: QueueName, payload: T): Promise<void> {
      if (!connected || !channel) {
        throw new Error(`RabbitMQ not connected — publish to ${queue} rejected`);
      }
      const content = Buffer.from(JSON.stringify(payload));
      // Confirm channel callback: broker ack'i (veya nack) geldiğinde tetiklenir.
      // Bu sayede çağıran kod mesajın gerçekten enqueue edildiğini bilir.
      await new Promise<void>((resolve, reject) => {
        channel.sendToQueue(queue, content, { persistent: true }, (err) => {
          if (err) reject(err instanceof Error ? err : new Error(String(err)));
          else resolve();
        });
      });
    },
    async consume<T>(queue: QueueName, handler: (payload: T) => Promise<void>): Promise<void> {
      // ÖNEMLİ-API-1.1.16 fix (2026-05-04): array push, multi-consumer destek.
      const list = consumers.get(queue) ?? [];
      list.push({ queue, handler: handler as (payload: unknown) => Promise<void> });
      consumers.set(queue, list);
      await startConsumer(queue, handler);
    },
    async close(): Promise<void> {
      // DÜŞÜK-API-1.1.19 fix (2026-05-04): channel.close await ediliyor; ama
      // amqplib'in cancelAll API'si yok — channel.close() server-side delivery
      // pause + buffered messages flush sağlıyor, sonra connection.close().
      closing = true;
      connected = false;
      try {
        await channel?.close();
      } catch (err) {
        logger.warn({ err }, 'RabbitMQ channel close hatası');
      }
      try {
        await connection?.close();
      } catch (err) {
        logger.warn({ err }, 'RabbitMQ connection close hatası');
      }
    },
  };
}

export const rabbitmqPlugin = fp(async (app: FastifyInstance) => {
  const url = process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672';
  // MED-API-025 fix (2026-05-05): production'da `RABBITMQ_OPTIONAL=true` env'i
  // tanınır ama default false; non-production sadece dev/test'te otomatik
  // optional. Eski kod prod'da bile NODE_ENV!=='production' kontrolü ile
  // optional olabilirdi (NODE_ENV unset ise) — şimdi explicit.
  const isProduction = process.env.NODE_ENV === 'production';
  const optional =
    isProduction
      ? process.env.RABBITMQ_OPTIONAL === 'true'
      : true;   // dev/test'te varsayılan optional (entegrasyon için)

  try {
    const client = await createRabbitMQClient(url, app.log);
    app.decorate('rabbitmq', client);
    app.addHook('onClose', async () => { await client.close(); });
  } catch (err) {
    if (!optional) {
      // FATAL: prod'da RabbitMQ optional değilse hard fail.
      app.log.fatal({ err }, 'RabbitMQ bağlantısı başarısız (production, RABBITMQ_OPTIONAL!=true) — boot abort');
      throw err;
    }

    app.log.error({ err }, 'RabbitMQ bağlantısı başarısız — messages drop ediliyor (optional mode)');
    app.decorate('rabbitmq', {
      isConnected: () => false,
      publish:  async () => { app.log.warn('RabbitMQ unavailable, message dropped'); },
      consume:  async () => { app.log.warn('RabbitMQ unavailable, consumer not started'); },
      close:    async () => {},
    });
  }
});
