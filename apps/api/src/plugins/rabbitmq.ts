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

async function createRabbitMQClient(url: string, logger: FastifyInstance['log']): Promise<RabbitMQClient> {
  let connection: ChannelModel;
  let channel: ConfirmChannel;
  let connected = false;
  let closing = false;
  const consumers = new Map<QueueName, ConsumerRecord>();

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
        for (const record of consumers.values()) {
          await startConsumer(record.queue, record.handler as (payload: unknown) => Promise<void>);
        }
        return;
      } catch (err) {
        logger.warn({ attempt, err }, 'RabbitMQ connection failed, retrying...');
        const delay = Math.min(3000 * attempt, 30000);
        await new Promise((r) => setTimeout(r, delay));
      }
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
      try {
        const payload = JSON.parse(msg.content.toString()) as T;
        await handler(payload);
        channel.ack(msg);
      } catch (err) {
        logger.error({ err }, `Error processing message from ${queue}`);
        channel.nack(msg, false, false);
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
      consumers.set(queue, { queue, handler: handler as (payload: unknown) => Promise<void> });
      await startConsumer(queue, handler);
    },
    async close(): Promise<void> {
      closing = true;
      connected = false;
      await channel.close();
      await connection.close();
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
