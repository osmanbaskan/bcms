import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import ffprobePath from '@ffprobe-installer/ffprobe';
import type { FastifyInstance } from 'fastify';
import { QUEUES } from '../../plugins/rabbitmq.js';
import { validateIngestSourcePath } from './ingest.paths.js';
import { finalizeIngestJob } from './ingest.service.js';

ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH ?? ffmpegPath.path);
ffmpeg.setFfprobePath(process.env.FFPROBE_PATH ?? ffprobePath.path);

// ── QC eşikleri ───────────────────────────────────────────────────────────────
const QC_THRESHOLDS = {
  maxLoudness:    -16,  // LUFS (EBU R128: -23 ± 1 ideal, yayın için -16 max)
  minLoudness:    -30,
  minDuration:    60,   // saniye
  allowedCodecs:  ['h264', 'h265', 'hevc', 'prores', 'dnxhd'],
};

/** HIGH-API-016 fix (2026-05-05): ffmpeg/ffprobe işlemlerine timeout.
 *  Bozuk/atılmış container source'larda spawn deadlock olabilir. 5dk hard cap.
 *  Çağrı `Promise.race` + reject ile sarmaydı; ancak fluent-ffmpeg child process
 *  kill etme imkanı `command.kill('SIGKILL')` ile mümkün — kontrolü ona bırak. */
const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); },
           (e) => { clearTimeout(t); reject(e); });
  });
}

// ORTA-API-1.5.7 fix (2026-05-04): proxy dir absolute path warning.
// Relative path './tmp/proxies' worker container restart sonrası volume mount
// yoksa proxy file'lar kayıp olur. Absolute path zorunlu (production'da
// PROXY_OUTPUT_DIR env'i bind-mount edilmiş volume'a yönelmeli).
const PROXY_OUTPUT_DIR = process.env.PROXY_OUTPUT_DIR ?? './tmp/proxies';
if (!path.isAbsolute(PROXY_OUTPUT_DIR)) {
  // Boot anında uyar; throw etmiyoruz çünkü dev/test'te relative kullanılabilir.
  // eslint-disable-next-line no-console
  console.warn(`[ingest.worker] PROXY_OUTPUT_DIR relative path ('${PROXY_OUTPUT_DIR}'); production'da absolute + persistent volume kullanın.`);
}

interface IngestMessage {
  jobId:      number;
  sourcePath: string;
  targetId?:  number;
}

// ── Checksum ──────────────────────────────────────────────────────────────────
function computeChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      reject(new Error(`Dosya bulunamadı: ${filePath}`));
      return;
    }
    const hash   = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end',  () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ── ffprobe analizi ───────────────────────────────────────────────────────────
interface MediaInfo {
  codec:      string;
  resolution: string;
  duration:   number;
  frameRate:  number;
  bitrate:    number;
}

function probeFile(filePath: string): Promise<MediaInfo> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) { reject(err); return; }

      const videoStream = data.streams.find((s) => s.codec_type === 'video');
      const fmt         = data.format;

      const frameRateStr = videoStream?.r_frame_rate ?? '25/1';
      const [num, den]   = frameRateStr.split('/').map(Number);
      const frameRate    = den ? num / den : num;

      resolve({
        codec:      videoStream?.codec_name ?? 'unknown',
        resolution: videoStream ? `${videoStream.width}x${videoStream.height}` : 'unknown',
        duration:   Number(fmt.duration ?? 0),
        frameRate:  Math.round(frameRate * 100) / 100,
        bitrate:    Math.round(Number(fmt.bit_rate ?? 0) / 1000), // kbps
      });
    });
  });
}

// ── Loudness ölçümü (EBU R128) ────────────────────────────────────────────────
function measureLoudness(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = '';
    ffmpeg(filePath)
      .audioFilters('ebur128=peak=true')
      .format('null')
      .output('/dev/null')
      .on('stderr', (line: string) => { output += line + '\n'; })
      .on('end', () => {
        const match = output.match(/I:\s*([-\d.]+)\s*LUFS/);
        resolve(match ? parseFloat(match[1]) : -99);
      })
      .on('error', (err) => {
        // Loudness ölçümü başarısız olsa da devam et
        resolve(-99);
      })
      .run();
  });
}

// ── Proxy üretimi (720p H.264 2Mbps) ─────────────────────────────────────────
function generateProxy(sourcePath: string, jobId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(PROXY_OUTPUT_DIR, { recursive: true });
    const outFile = path.join(PROXY_OUTPUT_DIR, `proxy_${jobId}.mp4`);

    ffmpeg(sourcePath)
      .videoCodec('libx264')
      .videoBitrate('2000k')
      .size('?x720')          // 720p, en-boy oranını koru
      .audioCodec('aac')
      .audioBitrate('128k')
      .outputOptions(['-preset fast', '-movflags +faststart'])
      .output(outFile)
      .on('end',   () => resolve(outFile))
      .on('error', reject)
      .run();
  });
}

// ORTA-API-1.5.6 helper (2026-05-04): file path redaction.
// /opta/.../file.mp4 → /opta/<file>; /tmp/proxies/x.mp4 → /tmp/proxies/<file>.
// Sadece uzun absolute path'leri kısaltır; informasyon tutar (klasör), sızdırmaz (full path).
function redactPaths(msg: string): string {
  return msg.replace(/(\/[A-Za-z0-9._-]+){3,}/g, (m) => {
    const parts = m.split('/').filter(Boolean);
    const top = parts.slice(0, 1).join('/');
    const last = parts[parts.length - 1];
    return `/${top}/.../${last}`;
  });
}

// ── Ana worker ────────────────────────────────────────────────────────────────
export async function startIngestWorker(app: FastifyInstance): Promise<void> {
  await app.rabbitmq.consume<IngestMessage>(QUEUES.INGEST_NEW, async (msg) => {
    const { jobId, sourcePath } = msg;

    // ÖNEMLİ-API-1.5.4 fix (2026-05-04): idempotency / dedup.
    // RabbitMQ at-least-once teslim ediyor; aynı jobId redeliver edildiğinde
    // PROCESSING'ten yeniden başlamasın. Sadece PENDING/QUEUED state'inden
    // ileri taşıyoruz; diğer state'ler "zaten işlendi/işleniyor" demek.
    const existing = await app.prisma.ingestJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    if (!existing) {
      app.log.warn({ jobId }, 'Ingest message için DB job bulunamadı; mesaj drop ediliyor');
      return;
    }
    if (existing.status !== 'PENDING') {
      app.log.info({ jobId, status: existing.status }, 'Ingest job zaten işlenmiş — duplicate consume skip');
      return;
    }
    app.log.info({ jobId, sourcePath }, 'Ingest işi başladı');

    // ── PROCESSING ─────────────────────────────────────────────────────────
    await app.prisma.ingestJob.update({
      where: { id: jobId },
      data:  { status: 'PROCESSING', startedAt: new Date() },
    });

    try {
      // 1. Path güvenlik kontrolü (path traversal engellemek için)
      const safePath = validateIngestSourcePath(sourcePath);

      // 2. Checksum (HIGH-API-016: 5dk hard timeout)
      const checksum = await withTimeout(computeChecksum(safePath), FFMPEG_TIMEOUT_MS, 'computeChecksum');
      await app.prisma.ingestJob.update({ where: { id: jobId }, data: { checksum } });

      // 3. ffprobe analizi (HIGH-API-016: 5dk hard timeout)
      const mediaInfo = await withTimeout(probeFile(safePath), FFMPEG_TIMEOUT_MS, 'ffprobe');
      app.log.info({ jobId, mediaInfo }, 'ffprobe tamamlandı');

      // ── PROXY_GEN ─────────────────────────────────────────────────────── (HIGH-API-016)
      await app.prisma.ingestJob.update({ where: { id: jobId }, data: { status: 'PROXY_GEN' } });
      const proxyPath = await withTimeout(generateProxy(safePath, jobId), FFMPEG_TIMEOUT_MS, 'generateProxy');
      await app.prisma.ingestJob.update({ where: { id: jobId }, data: { proxyPath } });
      app.log.info({ jobId, proxyPath }, 'Proxy üretildi');

      // ── QC ────────────────────────────────────────────────────────────── (HIGH-API-016)
      await app.prisma.ingestJob.update({ where: { id: jobId }, data: { status: 'QC' } });
      const loudness = await withTimeout(measureLoudness(safePath), FFMPEG_TIMEOUT_MS, 'measureLoudness');

      const errors:   string[] = [];
      const warnings: string[] = [];

      if (!QC_THRESHOLDS.allowedCodecs.includes(mediaInfo.codec.toLowerCase())) {
        errors.push(`Desteklenmeyen codec: ${mediaInfo.codec}`);
      }
      if (mediaInfo.duration < QC_THRESHOLDS.minDuration) {
        warnings.push(`Kısa süre: ${mediaInfo.duration.toFixed(1)}s`);
      }
      if (loudness > QC_THRESHOLDS.maxLoudness) {
        errors.push(`Yükseklik fazla: ${loudness} LUFS (max ${QC_THRESHOLDS.maxLoudness})`);
      }
      if (loudness < QC_THRESHOLDS.minLoudness && loudness !== -99) {
        warnings.push(`Yükseklik düşük: ${loudness} LUFS`);
      }

      const passed = errors.length === 0;

      await app.prisma.qcReport.upsert({
        where:  { jobId },
        create: { jobId, ...mediaInfo, loudness, errors, warnings, passed },
        update: { ...mediaInfo, loudness, errors, warnings, passed },
      });

      // ── COMPLETED ───────────────────────────────────────────────────────
      // Madde 2+7 PR-B3b-2: finalizeIngestJob tx içinde update + outbox shadow
      // (idempotencyKey set), tx dışı direct publish.
      await finalizeIngestJob(app, jobId, 'COMPLETED');
      app.log.info({ jobId, passed }, 'Ingest tamamlandı');

    } catch (err) {
      // ORTA-API-1.5.6 fix (2026-05-04): errorMsg'de dosya yolu sızıntısını
      // kapat. Worker INGEST_ALLOWED_ROOTS path'lerini disclose etmemeli;
      // UI'da tek satır mesaj gösteriliyor. Tam stack server log'unda kalır.
      const fullMsg = (err as Error).message;
      const errorMsg = redactPaths(fullMsg);
      app.log.error({ jobId, err }, 'Ingest başarısız');

      await finalizeIngestJob(app, jobId, 'FAILED', { errorMsg });
    }
  });

  app.log.info('Ingest worker başlatıldı');
}
