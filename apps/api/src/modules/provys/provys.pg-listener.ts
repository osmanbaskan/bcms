import { EventEmitter } from 'node:events';
import { Client as PgClient, type Notification } from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { PG_NOTIFY_CHANNEL } from './provys.service.js';

/**
 * Paylaşımlı PostgreSQL LISTEN client'ı — birden çok SSE bağlantısı
 * tek bir DB connection üstünden notification alır. Refcount sıfıra
 * düştüğünde DB connection kapatılır (kaynak tasarrufu); app close
 * hook'unda da hard close.
 *
 * Prisma uzun yaşamlı LISTEN'i desteklemediği için dedicated `pg`
 * client kullanılır (kullanıcı talimatı).
 */
export interface ProvysNotifyPayload {
  channelSlug: string;
}

export class ProvysPgListener {
  private client: PgClient | null = null;
  private connectPromise: Promise<void> | null = null;
  private refCount = 0;
  private closing = false;
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly databaseUrl: string,
    private readonly logger: FastifyBaseLogger,
  ) {
    this.emitter.setMaxListeners(0);
  }

  async subscribe(handler: (payload: ProvysNotifyPayload) => void): Promise<() => Promise<void>> {
    await this.ensureConnected();
    this.refCount += 1;
    this.emitter.on('notify', handler);

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this.emitter.off('notify', handler);
      this.refCount = Math.max(0, this.refCount - 1);
      if (this.refCount === 0) {
        await this.disconnect();
      }
    };
  }

  async close(): Promise<void> {
    this.closing = true;
    this.emitter.removeAllListeners('notify');
    this.refCount = 0;
    await this.disconnect();
  }

  private async ensureConnected(): Promise<void> {
    if (this.client) return;
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = (async () => {
      const client = new PgClient({ connectionString: this.databaseUrl });
      client.on('error', (err: Error) => {
        this.logger.error({ err }, 'Provys pg listener: connection error');
      });
      client.on('notification', (msg: Notification) => {
        if (msg.channel !== PG_NOTIFY_CHANNEL) return;
        const raw = msg.payload ?? '';
        try {
          const parsed = JSON.parse(raw) as ProvysNotifyPayload;
          if (!parsed?.channelSlug) return;
          this.emitter.emit('notify', parsed);
        } catch (err) {
          this.logger.warn({ err, raw }, 'Provys pg listener: payload parse hatası');
        }
      });
      client.on('end', () => {
        this.client = null;
      });

      await client.connect();
      // Identifier — sabit ve safe, escape gerekmez ama defansif yine yaz.
      await client.query(`LISTEN "${PG_NOTIFY_CHANNEL}"`);
      this.client = client;
      this.logger.info({ channel: PG_NOTIFY_CHANNEL }, 'Provys pg listener bağlandı');
    })();

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async disconnect(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.client = null;
    try {
      if (!this.closing) {
        try { await client.query(`UNLISTEN "${PG_NOTIFY_CHANNEL}"`); }
        catch (err) { this.logger.debug({ err }, 'Provys pg listener: UNLISTEN sırasında hata'); }
      }
      await client.end();
    } catch (err) {
      this.logger.warn({ err }, 'Provys pg listener: kapanış hatası');
    }
  }
}

let singleton: ProvysPgListener | null = null;

export function getProvysPgListener(databaseUrl: string, logger: FastifyBaseLogger): ProvysPgListener {
  if (!singleton) singleton = new ProvysPgListener(databaseUrl, logger);
  return singleton;
}

export async function closeProvysPgListener(): Promise<void> {
  if (!singleton) return;
  await singleton.close();
  singleton = null;
}
