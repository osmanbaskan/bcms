import net from 'node:net';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * news-mos-sender — worker background servisi (2026-06-05).
 *
 * PENDING NewsMosJob'ları cihaz tipine göre gönderir:
 *   - VIZRT_REST : HTTP POST payloadXml → http://host:port/
 *   - MOS_TCP    : TCP socket'e MOS XML yaz
 *   - XML_FILE   : host dizinine .xml dosyası yaz
 * Başarı → SENT (sentAt); hata → attempts++ (MAX'ta FAILED). Cihaz yoksa FAILED.
 * Not: dry-run gönderimler job oluşturmaz (route'ta kesilir) — burada yalnız
 * gerçek cihazlı işler işlenir; cihaz yoksa bu env'de FAILED olması beklenir.
 */

const POLL_INTERVAL_MS = 5_000;
const BATCH = 20;
const MAX_ATTEMPTS = 3;
const SOCKET_TIMEOUT_MS = 8_000;

async function sendTcp(host: string, port: number, xml: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(SOCKET_TIMEOUT_MS);
    socket.on('connect', () => socket.end(xml));
    socket.on('error', reject);
    socket.on('timeout', () => { socket.destroy(); reject(new Error('TCP timeout')); });
    socket.on('close', () => resolve());
  });
}

async function sendHttp(host: string, port: number | null, xml: string): Promise<void> {
  const base = /^https?:\/\//.test(host) ? host : `http://${host}${port ? `:${port}` : ''}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), SOCKET_TIMEOUT_MS);
  try {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: xml,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } finally {
    clearTimeout(t);
  }
}

async function sendFile(dir: string, jobId: number, xml: string): Promise<void> {
  const file = path.join(dir, `bcms-mos-${jobId}.xml`);
  await writeFile(file, xml, 'utf8');
}

export function startNewsMosSender(app: FastifyInstance): void {
  let stopping = false;
  let running = false;

  const processOne = async (job: {
    id: number; action: string; payloadXml: string | null; attempts: number;
    device: { kind: string; host: string | null; port: number | null } | null;
  }): Promise<void> => {
    const device = job.device;
    const xml = job.payloadXml ?? '';
    try {
      if (!device || !device.host) throw new Error('Çıkış cihazı/host tanımsız');
      if (device.kind === 'MOS_TCP') {
        if (!device.port) throw new Error('MOS_TCP için port gerekli');
        await sendTcp(device.host, device.port, xml);
      } else if (device.kind === 'VIZRT_REST') {
        await sendHttp(device.host, device.port, xml);
      } else {
        await sendFile(device.host, job.id, xml);
      }
      await app.prisma.newsMosJob.update({
        where: { id: job.id },
        data: { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 }, error: null },
      });
    } catch (err) {
      const attempts = job.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      await app.prisma.newsMosJob.update({
        where: { id: job.id },
        data: {
          attempts,
          status: failed ? 'FAILED' : 'PENDING',
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  };

  const tick = async (): Promise<void> => {
    if (stopping || running) return;
    running = true;
    try {
      const jobs = await app.prisma.newsMosJob.findMany({
        where: { status: 'PENDING' },
        include: { device: { select: { kind: true, host: true, port: true } } },
        orderBy: { createdAt: 'asc' },
        take: BATCH,
      });
      for (const job of jobs) {
        if (stopping) break;
        await processOne(job);
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    tick().catch((err) => app.log.error({ err }, 'news-mos-sender tick hatası'));
  }, POLL_INTERVAL_MS);
  timer.unref?.();

  app.addHook('onClose', async () => {
    stopping = true;
    clearInterval(timer);
  });
}
