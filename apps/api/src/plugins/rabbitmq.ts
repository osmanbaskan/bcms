import fp from 'fastify-plugin';
import amqplib, { type Channel, type ChannelModel } from 'amqplib';
import type { FastifyInstance } from 'fastify';

// ── Queue / Exchange definitions ──────────────────────────────────────────────
export const QUEUES = {
  SCHEDULE_CREATED:   'queue.schedule.created',
  SCHEDULE_UPDATED:   'queue.schedule.updated',
  BOOKING_CREATED:    'queue.booking.created',
  INGEST_NEW:         'queue.ingest.new',
  INGEST_COMPLETED:   'queue.ingest.completed',
  NOTIFICATIONS_EMAIL:'queue.notifications.email',
  NOTIFICATIONS_SLACK:'queue.notifications.slack',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface RabbitMQClient {
  publish<T>(queue: QueueName, payload: T): Promise<void>;
  consume<T>(queue: QueueName, handler: (payload: T) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

declare module 'fastify' {
  interface FastifyInstance {
    rabbitmq: RabbitMQClient;
  }
}

async function createRabbitMQClient(url: string, logger: FastifyInstance['log']): Promise<RabbitMQClient> {
  let connection: ChannelModel;
  let channel: Channel;

  const connect = async (retries = 5): Promise<void> => {
    for (let i = 1; i <= retries; i++) {
      try {
        connection = await amqplib.connect(url);
        channel = await connection.createChannel();

        // Declare all queues as durable
        for (const queue of Object.values(QUEUES)) {
          await channel.assertQueue(queue, { durable: true });
        }

        connection.on('error', (err) => {
          logger.error({ err }, 'RabbitMQ connection error');
        });

        connection.on('close', () => {
          logger.warn('RabbitMQ connection closed, reconnecting...');
          setTimeout(() => connect(3), 5000);
        });

        logger.info('RabbitMQ connected');
        return;
      } catch (err) {
        logger.warn({ attempt: i, err }, 'RabbitMQ connection failed, retrying...');
        if (i === retries) throw err;
        await new Promise((r) => setTimeout(r, 3000 * i));
      }
    }
  };

  await connect();

  return {
    async publish<T>(queue: QueueName, payload: T): Promise<void> {
      const content = Buffer.from(JSON.stringify(payload));
      channel.sendToQueue(queue, content, { persistent: true });
    },
    async consume<T>(queue: QueueName, handler: (payload: T) => Promise<void>): Promise<void> {
      await channel.consume(queue, async (msg) => {
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
    },
    async close(): Promise<void> {
      await channel.close();
      await connection.close();
    },
  };
}

export const rabbitmqPlugin = fp(async (app: FastifyInstance) => {
  const url = process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672';

  try {
    const client = await createRabbitMQClient(url, app.log);
    app.decorate('rabbitmq', client);
    app.addHook('onClose', async () => { await client.close(); });
  } catch (err) {
    app.log.error({ err }, 'Failed to connect to RabbitMQ — messages will be lost');
    // Provide a no-op client so the API still starts without RabbitMQ
    app.decorate('rabbitmq', {
      publish:  async () => { app.log.warn('RabbitMQ unavailable, message dropped'); },
      consume:  async () => { app.log.warn('RabbitMQ unavailable, consumer not started'); },
      close:    async () => {},
    });
  }
});
