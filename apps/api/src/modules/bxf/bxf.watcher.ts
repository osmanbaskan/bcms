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

// ORTA-API-1.7.1 fix (2026-05-04): atomic write — write tmp file + rename.
// Eski hâl: writeFileSync direkt PROCESSED_FILE'a yazıyordu; concurrent BXF
// event'i veya crash anında dosya yarı yazılı kalabilirdi (corrupt JSON).
// rename() POSIX'te atomic; partial write durumunda eski dosya korunur.
function saveProcessed(map: Record<string, number>): void {
  const tmp = `${PROCESSED_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(map));
    fs.renameSync(tmp, PROCESSED_FILE);
  } catch {
    // Fail durumunda tmp'i temizle — corrupt artefact bırakma.
    try { fs.unlinkSync(tmp); } catch { /* yok say */ }
  }
}

// ── Ana watcher ───────────────────────────────────────────────────────────────
export async function startBxfWatcher(app: FastifyInstance): Promise<void> {
  // Kanal önbelleği
  const channelCache = new Map<string, number>();
  const reloadChannelCache = async (): Promise<void> => {
    const channels = await app.prisma.channel.findMany({ select: { id: true, name: true } });
    channelCache.clear();
    for (const ch of channels) {
      channelCache.set(normalizeChannelName(ch.name), ch.id);
    }
    app.log.info({ count: channels.length }, 'BXF watcher: kanal önbelleği yenilendi');
  };
  await reloadChannelCache();

  // ORTA-API-1.7.2 fix (2026-05-04): kanal cache 5 dk'da bir refresh.
  // Eski hâlinde boot anında bir kez doluyordu, runtime'da yeni kanal
  // eklenirse BXF eşleşmiyordu — restart gerekiyordu. Periyodik reload
  // yan etki olmadan dinamik kalır.
  const channelReloadInterval = setInterval(() => {
    reloadChannelCache().catch((err) => app.log.warn({ err }, 'BXF channel cache reload başarısız'));
  }, 5 * 60_000);
  channelReloadInterval.unref();

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

  // HIGH-API-018 fix (2026-05-05): graceful close on Fastify shutdown.
  app.addHook('onClose', async () => {
    clearInterval(channelReloadInterval);
    try {
      await watcher.close();
      app.log.info('BXF watcher kapandı');
    } catch (err) {
      app.log.warn({ err }, 'BXF watcher close hatası');
    }
  });

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

  // ORTA-API-1.7.4 fix (2026-05-04): bidirectional includes() pattern eski
  // hâlinde "bein sports" "bein sports 5" ile match edebiliyordu (2 kanalın
  // birbirini içermesi durumunda yanlış kanala yazma). Fuzzy fallback
  // tamamen kaldırıldı — channelCache.get() exact match yapıyor; eşleşmiyorsa
  // skip + warning log (kanal adı normalize sonrası tam eşleşmeli).

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

  // MED-API-004 fix (2026-05-05): findFirst + create transaction'sızdı —
  // concurrent BXF watch event'inde duplicate yaratabilirdi. Her event'i tek
  // transaction'da yap; aynı startTime için race olursa GiST exclusion ikinciyi
  // reddeder ve graceful skip yapılır.
  for (const ev of schedule.events) {
    try {
      await app.prisma.$transaction(async (tx) => {
        const exists = await tx.schedule.findFirst({
          where: { channelId, startTime: ev.startTime },
          select: { id: true },
        });
        if (exists) {
          skipped++;
          return;
        }
        await tx.schedule.create({
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
      });
    } catch (err) {
      // GiST exclusion (P2002/P2004) — concurrent başka event aynı slot'u almış.
      const e = err as { code?: string };
      if (e.code === 'P2002' || e.code === 'P2004') {
        skipped++;
      } else {
        throw err;
      }
    }
  }

  app.log.info(
    { file: key, channel: schedule.channelShortName, inserted, skipped },
    'BXF: import tamamlandı',
  );

  processed[key] = mtime;
  saveProcessed(processed);
}
