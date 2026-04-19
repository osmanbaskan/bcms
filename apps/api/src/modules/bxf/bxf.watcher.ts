import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import type { FastifyInstance } from 'fastify';
import { parseBxf } from './bxf.parser.js';

const BXF_WATCH_DIR  = process.env.BXF_WATCH_DIR ?? '/home/ubuntu/bxf';
const PROCESSED_FILE = path.join(BXF_WATCH_DIR, '.bxf_processed.json');

// ── Kanal adı normalizer ──────────────────────────────────────────────────────
// "xbeIN SPORTS 5 HD" → "bein sports 5"
function normalizeChannelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^x+/, '')                      // baştaki x/xx öneki kaldır
    .replace(/\b(hd|sd|ott|radio)\b/g, '')   // kalite takıları kaldır
    .replace(/\s+/g, ' ')
    .trim();
}

// ── İşlenmiş dosyaları takip eden JSON kaydı ─────────────────────────────────
function loadProcessed(): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveProcessed(map: Record<string, number>): void {
  try {
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify(map));
  } catch { /* sessiz hata */ }
}

// ── Ana watcher ───────────────────────────────────────────────────────────────
export async function startBxfWatcher(app: FastifyInstance): Promise<void> {
  // Kanal önbelleği
  const channelCache = new Map<string, number>();
  const channels = await app.prisma.channel.findMany({ select: { id: true, name: true } });
  for (const ch of channels) {
    channelCache.set(normalizeChannelName(ch.name), ch.id);
  }
  app.log.info({ count: channels.length }, 'BXF watcher: kanal önbelleği yüklendi');

  const processed = loadProcessed();

  // ── 1. Mevcut tüm dosyaları tarayarak işle ───────────────────────────────────
  let existing: string[];
  try {
    existing = fs.readdirSync(BXF_WATCH_DIR)
      .filter(f => f.toLowerCase().endsWith('.bxf'))
      .map(f => path.join(BXF_WATCH_DIR, f));
  } catch {
    existing = [];
  }

  app.log.info({ count: existing.length, folder: BXF_WATCH_DIR }, 'BXF: mevcut dosyalar taranıyor');
  for (const fp of existing) {
    await handleFile(fp, app, channelCache, processed);
  }
  app.log.info('BXF: mevcut dosya taraması tamamlandı');

  // ── 2. Yeni/değişen dosyaları izle ──────────────────────────────────────────
  const watcher = chokidar.watch(BXF_WATCH_DIR, {
    persistent:     true,
    ignoreInitial:  true,   // mevcut dosyalar yukarıda işlendi
    ignored:        /(^|[/\\])\..+/,
    awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 },
  });

  watcher.on('add',    (fp) => {
    handleFile(fp, app, channelCache, processed).catch(
      (err) => app.log.error({ err, fp }, 'BXF: beklenmeyen hata'),
    );
  });
  watcher.on('change', (fp) => {
    handleFile(fp, app, channelCache, processed).catch(
      (err) => app.log.error({ err, fp }, 'BXF: beklenmeyen hata'),
    );
  });
  watcher.on('error', (err) => app.log.error({ err }, 'BXF watcher hatası'));

  app.log.info({ folder: BXF_WATCH_DIR }, 'BXF klasörü izleniyor (yeni dosyalar bekleniyor)');
}

// ── Tek dosya işleme ──────────────────────────────────────────────────────────
async function handleFile(
  filePath: string,
  app: FastifyInstance,
  channelCache: Map<string, number>,
  processed: Record<string, number>,
): Promise<void> {
  if (path.extname(filePath).toLowerCase() !== '.bxf') return;

  let mtime: number;
  try {
    mtime = fs.statSync(filePath).mtimeMs;
  } catch {
    return;
  }

  const key = path.basename(filePath);
  if (processed[key] === mtime) return; // zaten işlendi

  app.log.info({ file: key }, 'BXF: işleniyor');

  const schedule = parseBxf(filePath);
  if (!schedule) {
    app.log.warn({ file: key }, 'BXF: parse edilemedi veya geçerli içerik yok');
    processed[key] = mtime;
    saveProcessed(processed);
    return;
  }

  // Kanal eşleştirmesi
  const normBxf = normalizeChannelName(schedule.channelFullName || schedule.channelShortName);
  let channelId = channelCache.get(normBxf);

  if (!channelId) {
    for (const [normDb, id] of channelCache) {
      if (normDb.includes(normBxf) || normBxf.includes(normDb)) {
        channelId = id;
        break;
      }
    }
  }

  if (!channelId) {
    app.log.warn(
      { file: key, shortName: schedule.channelShortName, fullName: schedule.channelFullName },
      "BXF: kanal DB'de bulunamadı, atlanıyor",
    );
    processed[key] = mtime;
    saveProcessed(processed);
    return;
  }

  let inserted = 0;
  let skipped  = 0;

  for (const ev of schedule.events) {
    const exists = await app.prisma.schedule.findFirst({
      where: { channelId, startTime: ev.startTime },
      select: { id: true },
    });
    if (exists) { skipped++; continue; }

    await app.prisma.schedule.create({
      data: {
        channelId,
        startTime: ev.startTime,
        endTime:   ev.endTime,
        title:     ev.title,
        status:    'DRAFT',
        createdBy: 'bxf-importer',
        metadata: {
          bxfEventId:  ev.eventId,
          houseNumber: ev.houseNumber,
          contentName: ev.contentName,
          description: ev.description,
          sourceFile:  key,
          importedAt:  new Date().toISOString(),
        },
      },
    });
    inserted++;
  }

  app.log.info(
    { file: key, channel: schedule.channelShortName, inserted, skipped },
    'BXF: import tamamlandı',
  );

  processed[key] = mtime;
  saveProcessed(processed);
}
