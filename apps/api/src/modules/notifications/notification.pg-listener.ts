import { EventEmitter } from 'node:events';
import { Client as PgClient, type Notification as PgNotification } from 'pg';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Bildirim (in-app push) için paylaşımlı PostgreSQL LISTEN client'ı.
 * provys.pg-listener deseninin birebir paraleli: birden çok SSE bağlantısı tek
 * DB connection üstünden `bcms_notify` kanalını dinler; refcount 0 olunca kapanır.
 * Prisma uzun yaşamlı LISTEN'i desteklemediği için dedicated `pg` client.
 */
export const NOTIFY_CHANNEL = 'bcms_notify';

/** pg_notify payload'u — SSE'nin DB'ye gitmeden erişim(grup)+abonelik süzmesi
 *  yapabilmesi için kendine yeterli. requiredGroups = tipi görebilen gruplar
 *  (sekme erişimi), defaultOn = abonelik satırı yoksa geçerli varsayılan. */
export interface NotifyPayload {
  id: number;
  type: string;
  section: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string | null;
  link: string | null;
  requiredGroups: string[];
  defaultOn: boolean;
  sound: string;
  createdAt: string;
}

export class NotificationPgListener {
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

  async subscribe(handler: (payload: NotifyPayload) => void): Promise<() => Promise<void>> {
    await this.ensureConnected();
    this.refCount += 1;
    this.emitter.on('notify', handler);

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this.emitter.off('notify', handler);
      this.refCount = Math.max(0, this.refCount - 1);
      if (this.refCount === 0) await this.disconnect();
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
    if (this.connectPromise) { await this.connectPromise; return; }

    this.connectPromise = (async () => {
      const client = new PgClient({ connectionString: this.databaseUrl });
      client.on('error', (err: Error) => {
        this.logger.error({ err }, 'Notification pg listener: connection error');
      });
      client.on('notification', (msg: PgNotification) => {
        if (msg.channel !== NOTIFY_CHANNEL) return;
        const raw = msg.payload ?? '';
        try {
          const parsed = JSON.parse(raw) as NotifyPayload;
          if (typeof parsed?.id !== 'number' || !Array.isArray(parsed?.requiredGroups)) return;
          this.emitter.emit('notify', parsed);
        } catch (err) {
          this.logger.warn({ err, raw }, 'Notification pg listener: payload parse hatası');
        }
      });
      client.on('end', () => { this.client = null; });

      await client.connect();
      await client.query(`LISTEN "${NOTIFY_CHANNEL}"`);
      this.client = client;
      this.logger.info({ channel: NOTIFY_CHANNEL }, 'Notification pg listener bağlandı');
    })();

    try { await this.connectPromise; }
    finally { this.connectPromise = null; }
  }

  private async disconnect(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.client = null;
    try {
      if (!this.closing) {
        try { await client.query(`UNLISTEN "${NOTIFY_CHANNEL}"`); }
        catch (err) { this.logger.debug({ err }, 'Notification pg listener: UNLISTEN hatası'); }
      }
      await client.end();
    } catch (err) {
      this.logger.warn({ err }, 'Notification pg listener: kapanış hatası');
    }
  }
}

let singleton: NotificationPgListener | null = null;

export function getNotificationPgListener(databaseUrl: string, logger: FastifyBaseLogger): NotificationPgListener {
  if (!singleton) singleton = new NotificationPgListener(databaseUrl, logger);
  return singleton;
}

export async function closeNotificationPgListener(): Promise<void> {
  if (!singleton) return;
  await singleton.close();
  singleton = null;
}
