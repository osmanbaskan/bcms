import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  PROVYS_CHANNELS,
  PROVYS_CHANNEL_SLUGS,
  type ProvysChannelSlug,
  type ProvysItemDto,
  type ProvysLiveTodayDto,
  type ProvysStreamEvent,
} from '@bcms/shared';
import { istanbulTodayDate } from '../../core/tz.js';
import { closeProvysPgListener, getProvysPgListener } from './provys.pg-listener.js';
import {
  exportFilename,
  exportProvysToExcelBuffer,
  exportProvysToPdfBuffer,
  type ProvysExportRow,
} from './provys.export.js';
import {
  buildSsdbInfoForRow,
  computeGroupSumFramesByDc,
  fetchSsdbCacheMap,
  isSsdbResolverEnabled,
  type ProvysRowForMerge,
} from './provys.ssdb-merge.js';
import { ResponseCache } from '../../lib/response-cache.js';
import { responseCacheTotal } from '../../plugins/metrics.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// YP0.2 (2026-05-29, 250 user scale): /restore-missing response cache.
// 250 user × 5sn polling = 50 req/sn × 12 DB query (6 kanal × 2) = 600 query/sn.
// TTL=5sn + in-flight dedup → ~12 query/sn (50× düşüş). TTL polling süresiyle
// eşleşir; kullanıcı görüş açısından gecikme fark edilmez.
// Key cardinality düşük: today-future:<today> + date:<YYYY-MM-DD>; LRU 16 yeterli.
type RestoreMissingResponse = {
  date: string;
  scope: 'single-date' | 'today-future';
  rows: Array<Record<string, unknown>>;
};
const restoreMissingCache = new ResponseCache<RestoreMissingResponse>({
  ttlMs: 5_000,
  maxEntries: 16,
  onResult: (result) => responseCacheTotal.inc({ key: 'restore-missing', result }),
});

// Dashboard hero — bugünün tüm kanallar CANLI listesi. Landing page'i 250 user
// yükler; CANLI günlük BXF ile seyrek değişir → TTL=30sn yeterli, key cardinality
// ~1 (today:<date>). dog-pile prevention paralel dashboard açılışlarını korur.
const liveTodayCache = new ResponseCache<ProvysLiveTodayDto[]>({
  ttlMs: 30_000,
  maxEntries: 4,
  onResult: (result) => responseCacheTotal.inc({ key: 'live-today', result }),
});

const channelQuerySchema = z.object({
  channel: z.enum(PROVYS_CHANNEL_SLUGS as [string, ...string[]]),
});

const channelDateQuerySchema = z.object({
  channel: z.enum(PROVYS_CHANNEL_SLUGS as [string, ...string[]]),
  // Default: Europe/Istanbul bugünün tarihi. UI date picker tarihi sağlar.
  date: z.string().regex(ISO_DATE_RE).optional(),
});

const CATEGORY_ENUM = ['REKLAM', 'KAMU_SPOTU', 'CANLI', 'PROGRAM', 'TANITIM', 'DIGER'] as const;

const exportQuerySchema = z.object({
  channel: z.enum(PROVYS_CHANNEL_SLUGS as [string, ...string[]]),
  date: z.string().regex(ISO_DATE_RE).optional(),
  /**
   * Virgül-ayrımlı kategori listesi (örn. `REKLAM,CANLI,PROGRAM`). Opsiyonel;
   * verilmezse tüm kategoriler dahil edilir. Tek geçersiz değer dahi 400.
   */
  categories: z.string().optional().refine((s) => {
    if (s === undefined || s === '') return true;
    return s.split(',').every((c) => (CATEGORY_ENUM as readonly string[]).includes(c.trim()));
  }, { message: 'Invalid category in categories parameter' }),
  /**
   * `Primary-ProgramHeader` satırlarını export'a dahil et. Default `false`
   * — UI'nın default davranışıyla aynı (Program başlıkları block manşeti,
   * aynı timecode'da Content satırıyla collision yapar).
   */
  includeProgramHeaders: z.enum(['true', 'false']).optional(),
});

/**
 * POST body schema — query alanlarına ek `notes` Map'i alır. UI'da kullanıcı
 * her satıra opsiyonel transient bir not yazabiliyor; export'ta o satırın
 * `userNote` alanı bu Map'ten override edilir. Map key = `provysItem.eventId`,
 * value = boş veya ≤500 karakterlik not. DB'ye yazılmaz; yalnız export request.
 */
const exportBodySchema = z.object({
  channel: z.enum(PROVYS_CHANNEL_SLUGS as [string, ...string[]]),
  date: z.string().regex(ISO_DATE_RE).optional(),
  categories: z.string().optional().refine((s) => {
    if (s === undefined || s === '') return true;
    return s.split(',').every((c) => (CATEGORY_ENUM as readonly string[]).includes(c.trim()));
  }, { message: 'Invalid category in categories parameter' }),
  includeProgramHeaders: z.enum(['true', 'false']).optional(),
  notes: z.record(z.string().min(1), z.string().max(500)).optional(),
});

function parseCategoriesFilter(value: string | undefined): ReadonlySet<string> | null {
  if (!value) return null;
  const set = new Set(value.split(',').map((c) => c.trim()).filter(Boolean));
  if (set.size === 0) return null;
  return set;
}

function shouldIncludeProgramHeaders(value: string | undefined): boolean {
  return value === 'true';
}

const ssdbInfoSchema = z.object({
  lookupStatus: z.enum(['found','missing_material','duration_unknown','ssdb_error']).nullable(),
  materialStatus: z.enum([
    'live_not_applicable','dc_not_applicable','unchecked','missing_material',
    'found_match','found_duration_mismatch','found_duration_unknown','ssdb_error',
  ]),
  statusLabel: z.string(),
  mediaGuid: z.string().nullable(),
  matchMethod: z.enum(['alias','original_filename','name_like']).nullable(),
  ssdbDurationFrames: z.number().int().nonnegative().nullable(),
  ssdbDurationTimecode: z.string().nullable(),
  provysDurationFrames: z.number().int().nonnegative().nullable(),
  frameRate: z.number().int().positive().nullable(),
  lastCheckedAt: z.string().nullable(),
  lastError: z.string().nullable(),
});

const itemDtoSchema = z.object({
  id: z.number().int(),
  channelSlug: z.enum(PROVYS_CHANNEL_SLUGS as [string, ...string[]]),
  scheduleDate: z.string().regex(ISO_DATE_RE),
  eventId: z.string(),
  sequence: z.number().int(),
  startAt: z.string(),
  durationMs: z.number().int().nullable(),
  startTimecode: z.string().nullable(),
  durationTimecode: z.string().nullable(),
  frameRate: z.number().int().nullable(),
  dcCode: z.string().nullable(),
  title: z.string(),
  rawKind: z.string().nullable(),
  category: z.enum(['REKLAM', 'KAMU_SPOTU', 'CANLI', 'PROGRAM', 'TANITIM', 'DIGER']),
  // 2026-05-26: BXF ham title kaynak alanları + series metadata
  versionName: z.string().nullable(),
  episodeName: z.string().nullable(),
  eventTitle: z.string().nullable(),
  contentName: z.string().nullable(),
  programName: z.string().nullable(),
  adType: z.string().nullable(),
  spotType: z.string().nullable(),
  titleSource: z.enum(['VERSION_NAME','EPISODE_NAME','EVENT_TITLE','CONTENT_NAME','PROGRAM_NAME','AD_TYPE_SPOT_TYPE','UNKNOWN']).nullable(),
  seriesName: z.string().nullable(),
  episodeNumber: z.number().int().nullable(),
  sourceFile: z.string(),
  userNote: z.string().nullable(),
  updatedAt: z.string(),
  ssdb: ssdbInfoSchema,
});
const itemsResponseSchema = z.array(itemDtoSchema);

/** PATCH /provys/items/:id/note body. 2000 char limit yeterli marj. */
const noteUpdateBodySchema = z.object({
  note: z.string().max(2000).nullable(),
});

function dateToIso(d: Date): string {
  // @db.Date sütunu UTC midnight olarak okunur — slice 0..10 doğru günü verir.
  return d.toISOString().slice(0, 10);
}

function rowsToDto(rows: Array<{
  id: number;
  channelSlug: string;
  scheduleDate: Date;
  eventId: string;
  sequence: number;
  startAt: Date;
  durationMs: number | null;
  startTimecode: string | null;
  durationTimecode: string | null;
  frameRate: number | null;
  dcCode: string | null;
  title: string;
  rawKind: string | null;
  category: string;
  versionName: string | null;
  episodeName: string | null;
  eventTitle: string | null;
  contentName: string | null;
  programName: string | null;
  adType: string | null;
  spotType: string | null;
  titleSource: string | null;
  seriesName: string | null;
  episodeNumber: number | null;
  sourceFile: string;
  userNote: string | null;
  updatedAt: Date;
}>): ProvysItemDto[] {
  return rows.map((r) => ({
    id: r.id,
    channelSlug: r.channelSlug as ProvysItemDto['channelSlug'],
    scheduleDate: dateToIso(r.scheduleDate),
    eventId: r.eventId,
    sequence: r.sequence,
    startAt: r.startAt.toISOString(),
    durationMs: r.durationMs,
    startTimecode: r.startTimecode,
    durationTimecode: r.durationTimecode,
    frameRate: r.frameRate,
    dcCode: r.dcCode,
    title: r.title,
    rawKind: r.rawKind,
    category: r.category as ProvysItemDto['category'],
    versionName: r.versionName,
    episodeName: r.episodeName,
    eventTitle: r.eventTitle,
    contentName: r.contentName,
    programName: r.programName,
    adType: r.adType,
    spotType: r.spotType,
    titleSource: r.titleSource as ProvysItemDto['titleSource'],
    seriesName: r.seriesName,
    episodeNumber: r.episodeNumber,
    sourceFile: r.sourceFile,
    userNote: r.userNote,
    updatedAt: r.updatedAt.toISOString(),
    // Cache miss default. fetchChannelDateSnapshot tarafi cache hit'i
    // mergeSsdbCache ile uzerine yazar. PATCH /note path'inde cache okumaz;
    // bir sonraki SSE update'inde worker `provys_changed` ile dogru deger gelir.
    ssdb: buildSsdbInfoForRow(
      { category: r.category, dcCode: r.dcCode, durationMs: r.durationMs,
        durationTimecode: r.durationTimecode, frameRate: r.frameRate },
      null,
    ),
  }));
}

async function fetchChannelDateSnapshot(
  app: FastifyInstance,
  channelSlug: string,
  scheduleDate: string,
): Promise<ProvysItemDto[]> {
  const dt = new Date(`${scheduleDate}T00:00:00Z`);
  const rows = await app.prisma.provysItem.findMany({
    where: { channelSlug, scheduleDate: dt },
    // Multi-BXF günlerde sequence file-scoped olduğundan tek başına yetmez
    // (aynı sequence numarası birden çok dosyada tekrarlanabilir, saat
    // sıralaması ters dönerdi). startAt birinci kriter; timecode frame'i
    // ayırt eder; sourceFile + sequence file-içi deterministic tie-break.
    orderBy: [
      { startAt: 'asc' },
      { startTimecode: 'asc' },
      { sourceFile: 'asc' },
      { sequence: 'asc' },
    ],
  });

  // Cache merge: flag off iken Prisma'ya hic dokunmaz; CANLI + dcCode null
  // satirlar zaten eligible degil. Cache hit'leri buildSsdbInfoForRow ile
  // her DTO uzerine yazilir.
  const flagEnabled = isSsdbResolverEnabled();
  const provysForMerge: ProvysRowForMerge[] = rows.map((r) => ({
    category: r.category, dcCode: r.dcCode, durationMs: r.durationMs,
    durationTimecode: r.durationTimecode, frameRate: r.frameRate,
  }));
  const cacheMap = await fetchSsdbCacheMap(app.prisma, provysForMerge, flagEnabled);

  // 2026-05-27: Split material kontrolü için (channel, scheduleDate) sınırında
  // dcCode bazlı toplam frame süresi. Aynı dcCode birden fazla satıra
  // bölünmüşse (örn. araya REKLAM giren program), her satırın duration mismatch
  // alarmı toplam süre uyumlu olduğunda kaldırılır.
  const groupSumByDc = computeGroupSumFramesByDc(provysForMerge);

  const dtos = rowsToDto(rows);
  // dtos `ssdb` zaten cache-miss default'u ile dolu; cache hit varsa override.
  for (let i = 0; i < dtos.length; i++) {
    const row = provysForMerge[i];
    const dc = row.dcCode?.trim();
    if (!dc) continue;
    const cacheRow = cacheMap.get(dc);
    if (cacheRow) {
      const groupSum = groupSumByDc.get(dc) ?? null;
      dtos[i].ssdb = buildSsdbInfoForRow(row, cacheRow, groupSum);
    }
  }
  return dtos;
}

/**
 * Bugün + gelecek (today-future) snapshot — Restore sekmesi için planlanmış
 * yayın günlerini tek seferde döner. fromIstanbulDate (default istanbulTodayDate())
 * dahil sonraki günler `provys_items` satırları çekilir; SSDB cache merge + duration
 * group-sum hesabı `fetchChannelDateSnapshot` ile aynı politika.
 *
 * P1.6 (2026-05-29, 250 user scale): upper bound `PROVYS_RESTORE_FUTURE_DAYS`
 * (default 14, max 60). BXF importer 7-14 gün öncesinden yayın günleri yazar;
 * 14 gün operasyon penceresi için yeterli. Payload tipik 1 MB → ~200 KB
 * (5× düşüş); 6 kanal × 250 user'da network bandwidth ciddi kazanç.
 */
const RESTORE_FUTURE_DAYS = (() => {
  const raw = Number(process.env.PROVYS_RESTORE_FUTURE_DAYS);
  if (!Number.isFinite(raw) || raw <= 0) return 14;
  return Math.min(Math.floor(raw), 60);
})();

async function fetchChannelTodayFutureSnapshot(
  app: FastifyInstance,
  channelSlug: string,
  fromIstanbulDate: string,
): Promise<ProvysItemDto[]> {
  const fromUtc = new Date(`${fromIstanbulDate}T00:00:00Z`);
  // P1.6 cap: from + N gün (exclusive). Date aritmetiği UTC üzerinde — fromUtc
  // zaten 00:00:00Z; +N gün ekleme DST'den bağımsız (Europe/Istanbul DST yok
  // 2016 sonrası; yine de UTC aritmetik defansif).
  const toUtc = new Date(fromUtc.getTime() + RESTORE_FUTURE_DAYS * 24 * 60 * 60 * 1000);
  const rows = await app.prisma.provysItem.findMany({
    where: { channelSlug, scheduleDate: { gte: fromUtc, lt: toUtc } },
    orderBy: [
      { scheduleDate: 'asc' },
      { startAt: 'asc' },
      { startTimecode: 'asc' },
      { sourceFile: 'asc' },
      { sequence: 'asc' },
    ],
  });

  const flagEnabled = isSsdbResolverEnabled();
  const provysForMerge: ProvysRowForMerge[] = rows.map((r) => ({
    category: r.category, dcCode: r.dcCode, durationMs: r.durationMs,
    durationTimecode: r.durationTimecode, frameRate: r.frameRate,
  }));
  const cacheMap = await fetchSsdbCacheMap(app.prisma, provysForMerge, flagEnabled);
  const groupSumByDc = computeGroupSumFramesByDc(provysForMerge);

  const dtos = rowsToDto(rows);
  for (let i = 0; i < dtos.length; i++) {
    const row = provysForMerge[i];
    const dc = row.dcCode?.trim();
    if (!dc) continue;
    const cacheRow = cacheMap.get(dc);
    if (cacheRow) {
      const groupSum = groupSumByDc.get(dc) ?? null;
      dtos[i].ssdb = buildSsdbInfoForRow(row, cacheRow, groupSum);
    }
  }
  return dtos;
}

export async function provysRoutes(app: FastifyInstance) {
  // GET /api/v1/provys/channels
  app.get('/channels', {
    preHandler: app.requireGroup(...PERMISSIONS.provys.read),
    schema: { tags: ['Provys'], summary: 'Provys kanal kataloğu' },
  }, async () => {
    return PROVYS_CHANNELS.map((c) => ({
      fileCode: c.fileCode,
      slug: c.slug,
      displayName: c.displayName,
    }));
  });

  // GET /api/v1/provys/items?channel=<slug>&date=YYYY-MM-DD
  // `date` opsiyonel — default Europe/Istanbul bugünün tarihi.
  app.get('/items', {
    preHandler: app.requireGroup(...PERMISSIONS.provys.read),
    schema: { tags: ['Provys'], summary: 'Kanalın seçili güne ait akış listesi' },
  }, async (request: FastifyRequest) => {
    const parsed = channelDateQuerySchema.parse(request.query);
    const date = parsed.date ?? istanbulTodayDate();
    const items = await fetchChannelDateSnapshot(app, parsed.channel, date);
    return itemsResponseSchema.parse(items);
  });

  // GET /api/v1/provys/live-today
  // Dashboard hero + "Bugün canlı yayın" KPI: bugünün TÜM kanallardaki CANLI
  // kategorili event'leri, başlangıç saatine göre sıralı tek liste. `dcCode`
  // KASITLI dönmez (UI'da DC kod gösterilmez). SSDB merge yok.
  // KANAL-AGNOSTİK: channelSlug filtresi/loop YOK — Provys'e yeni kanal
  // eklendiğinde CANLI verisi otomatik dahil olur (kataloğa eklenmese bile
  // channelName slug'a düşer). Bu endpoint'e tekrar dokunmaya gerek yok.
  app.get('/live-today', {
    preHandler: app.requireGroup(...PERMISSIONS.provys.read),
    schema: { tags: ['Provys'], summary: 'Bugün — tüm kanallar CANLI event listesi (dashboard hero)' },
  }, async () => {
    const today = istanbulTodayDate();
    return liveTodayCache.getOrCompute(`today:${today}`, async () => {
      const dt = new Date(`${today}T00:00:00Z`);
      const displayName = new Map(PROVYS_CHANNELS.map((c) => [c.slug, c.displayName]));
      const rows = await app.prisma.provysItem.findMany({
        where: { scheduleDate: dt, category: 'CANLI' },
        select: {
          id: true, channelSlug: true, startTimecode: true,
          startAt: true, durationTimecode: true, title: true,
        },
        // startAt birinci kriter (kanallar arası kronolojik birleşik liste);
        // startTimecode aynı saniyedeki frame'i ayırt eder.
        orderBy: [{ startAt: 'asc' }, { startTimecode: 'asc' }],
      });
      return rows.map((r): ProvysLiveTodayDto => ({
        id: r.id,
        channelSlug: r.channelSlug as ProvysChannelSlug,
        channelName: displayName.get(r.channelSlug) ?? r.channelSlug,
        startTimecode: r.startTimecode,
        durationTimecode: r.durationTimecode,
        title: r.title,
      }));
    });
  });

  // PATCH /api/v1/provys/items/:id/note — kullanıcı serbest not güncellemesi.
  // Provys composed snapshot diff bu kolona dokunmaz (buildDiff update data'sında
  // user_note yok); watcher sync sırasında not korunur.
  app.patch<{ Params: { id: string }; Body: { note: string | null } }>(
    '/items/:id/note',
    {
      preHandler: app.requireGroup(...PERMISSIONS.provys.read),
      schema: { tags: ['Provys'], summary: 'Provys item için kullanıcı notu güncelle' },
    },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'invalid id' });
      }
      const body = noteUpdateBodySchema.parse(request.body);
      const trimmed = body.note == null ? null : body.note.trim() === '' ? null : body.note;
      try {
        const updated = await app.prisma.provysItem.update({
          where: { id },
          data: { userNote: trimmed },
          select: {
            id: true, channelSlug: true, scheduleDate: true, eventId: true,
            sequence: true, startAt: true, durationMs: true,
            startTimecode: true, durationTimecode: true, frameRate: true,
            dcCode: true, title: true, rawKind: true, category: true,
            versionName: true, episodeName: true, eventTitle: true,
            contentName: true, programName: true, adType: true, spotType: true,
            titleSource: true, seriesName: true, episodeNumber: true,
            sourceFile: true, userNote: true, updatedAt: true,
          },
        });
        const [dto] = rowsToDto([updated]);
        // pg_notify ile SSE consumer'ları taze DTO'yu çekecek
        await app.prisma.$executeRaw`SELECT pg_notify('provys_changed', ${JSON.stringify({
          channelSlug: updated.channelSlug,
          scheduleDate: updated.scheduleDate.toISOString().slice(0, 10),
        })})`;
        return itemDtoSchema.parse(dto);
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'provys item not found' });
        }
        throw err;
      }
    },
  );

  // GET /api/v1/provys/export/excel?channel=<slug>&date=YYYY-MM-DD&categories=REKLAM,CANLI,...
  // `categories` opsiyonel — verilmezse tüm kategoriler dahil; verilirse
  // sadece o kategorilerdeki satırlar export'a yansır (UI filtre paritesi).
  app.get('/export/excel', {
    preHandler: app.requireGroup(...PERMISSIONS.provys.read),
    schema: { tags: ['Provys'], summary: 'Excel export — kanal × gün snapshot (kategori filtreli)' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = exportQuerySchema.parse(request.query);
    const date = parsed.date ?? istanbulTodayDate();
    const allow = parseCategoriesFilter(parsed.categories);
    const includeHeaders = shouldIncludeProgramHeaders(parsed.includeProgramHeaders);
    const items = await fetchChannelDateSnapshot(app, parsed.channel, date);
    const rows: ProvysExportRow[] = items
      .filter((i) => !allow || allow.has(i.category))
      .filter((i) => includeHeaders || i.rawKind !== 'ProgramHeader')
      .map((i) => ({
        sequence: i.sequence,
        startTimecode: i.startTimecode,
        durationTimecode: i.durationTimecode,
        dcCode: i.dcCode,
        title: i.title,
        category: i.category,
        rawKind: i.rawKind,
        sourceFile: i.sourceFile,
        userNote: i.userNote,
        seriesName: i.seriesName,
        episodeNumber: i.episodeNumber,
        versionName: i.versionName,
        titleSource: i.titleSource,
      }));
    const buf = await exportProvysToExcelBuffer({ channelSlug: parsed.channel, scheduleDate: date, rows });
    const filename = exportFilename(parsed.channel, date, 'xlsx');
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(buf);
  });

  // GET /api/v1/provys/export/pdf?channel=<slug>&date=YYYY-MM-DD&categories=...
  app.get('/export/pdf', {
    preHandler: app.requireGroup(...PERMISSIONS.provys.read),
    schema: { tags: ['Provys'], summary: 'PDF export — kanal × gün snapshot (kategori filtreli)' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = exportQuerySchema.parse(request.query);
    const date = parsed.date ?? istanbulTodayDate();
    const allow = parseCategoriesFilter(parsed.categories);
    const includeHeaders = shouldIncludeProgramHeaders(parsed.includeProgramHeaders);
    const items = await fetchChannelDateSnapshot(app, parsed.channel, date);
    const rows: ProvysExportRow[] = items
      .filter((i) => !allow || allow.has(i.category))
      .filter((i) => includeHeaders || i.rawKind !== 'ProgramHeader')
      .map((i) => ({
        sequence: i.sequence,
        startTimecode: i.startTimecode,
        durationTimecode: i.durationTimecode,
        dcCode: i.dcCode,
        title: i.title,
        category: i.category,
        rawKind: i.rawKind,
        sourceFile: i.sourceFile,
        userNote: i.userNote,
        seriesName: i.seriesName,
        episodeNumber: i.episodeNumber,
        versionName: i.versionName,
        titleSource: i.titleSource,
      }));
    const buf = await exportProvysToPdfBuffer({ channelSlug: parsed.channel, scheduleDate: date, rows });
    const filename = exportFilename(parsed.channel, date, 'pdf');
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(buf);
  });

  // POST /api/v1/provys/export/excel  (notes body destekli)
  // Aynı semantik GET endpoint + body'de `notes: Record<eventId, string>` ile
  // UI'da kullanıcının yazdığı transient notlar export'a override edilir.
  app.post('/export/excel', {
    preHandler: app.requireGroup(...PERMISSIONS.provys.read),
    schema: { tags: ['Provys'], summary: 'Excel export (POST, transient notes desteği)' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = exportBodySchema.parse(request.body);
    const date = parsed.date ?? istanbulTodayDate();
    const allow = parseCategoriesFilter(parsed.categories);
    const includeHeaders = shouldIncludeProgramHeaders(parsed.includeProgramHeaders);
    const items = await fetchChannelDateSnapshot(app, parsed.channel, date);
    const notes = parsed.notes ?? {};
    const rows: ProvysExportRow[] = items
      .filter((i) => !allow || allow.has(i.category))
      .filter((i) => includeHeaders || i.rawKind !== 'ProgramHeader')
      .map((i) => ({
        sequence: i.sequence,
        startTimecode: i.startTimecode,
        durationTimecode: i.durationTimecode,
        dcCode: i.dcCode,
        title: i.title,
        category: i.category,
        rawKind: i.rawKind,
        sourceFile: i.sourceFile,
        userNote: notes[i.eventId] ?? i.userNote,
        seriesName: i.seriesName,
        episodeNumber: i.episodeNumber,
        versionName: i.versionName,
        titleSource: i.titleSource,
      }));
    const buf = await exportProvysToExcelBuffer({ channelSlug: parsed.channel, scheduleDate: date, rows });
    const filename = exportFilename(parsed.channel, date, 'xlsx');
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(buf);
  });

  // POST /api/v1/provys/export/pdf  (notes body destekli)
  app.post('/export/pdf', {
    preHandler: app.requireGroup(...PERMISSIONS.provys.read),
    schema: { tags: ['Provys'], summary: 'PDF export (POST, transient notes desteği)' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = exportBodySchema.parse(request.body);
    const date = parsed.date ?? istanbulTodayDate();
    const allow = parseCategoriesFilter(parsed.categories);
    const includeHeaders = shouldIncludeProgramHeaders(parsed.includeProgramHeaders);
    const items = await fetchChannelDateSnapshot(app, parsed.channel, date);
    const notes = parsed.notes ?? {};
    const rows: ProvysExportRow[] = items
      .filter((i) => !allow || allow.has(i.category))
      .filter((i) => includeHeaders || i.rawKind !== 'ProgramHeader')
      .map((i) => ({
        sequence: i.sequence,
        startTimecode: i.startTimecode,
        durationTimecode: i.durationTimecode,
        dcCode: i.dcCode,
        title: i.title,
        category: i.category,
        rawKind: i.rawKind,
        sourceFile: i.sourceFile,
        userNote: notes[i.eventId] ?? i.userNote,
        seriesName: i.seriesName,
        episodeNumber: i.episodeNumber,
        versionName: i.versionName,
        titleSource: i.titleSource,
      }));
    const buf = await exportProvysToPdfBuffer({ channelSlug: parsed.channel, scheduleDate: date, rows });
    const filename = exportFilename(parsed.channel, date, 'pdf');
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(buf);
  });

  // GET /api/v1/provys/restore-missing[?date=YYYY-MM-DD]
  // 2026-05-28 revize: `date` parametresi OPSIYONEL.
  //   - date verilirse → o günün (legacy single-date scope) eksik materyalleri.
  //   - date yoksa     → bugün + gelecek tüm günlerin eksik materyalleri
  //                      (today-future scope). Restore sekmesi varsayılan akış.
  //
  // Filtreler (her satır için hepsi):
  //  - dcCode null/empty/whitespace ise hariç
  //  - category === 'CANLI' hariç
  //  - rawKind === 'ProgramHeader' hariç
  //  - SSDB materialStatus === 'missing_material' (cache "yok" cevabı)
  //
  // Sıralama (today-future): scheduleDate asc → startAt asc → channelOrder asc → startTimecode asc.
  app.get('/restore-missing', {
    preHandler: app.requireGroup(...PERMISSIONS.provys.read),
    schema: { tags: ['Provys'], summary: '6 kanal birleşik — eksik materyal (today-future veya tek gün)' },
  }, async (request: FastifyRequest) => {
    const parsed = z.object({
      date: z.string().regex(ISO_DATE_RE).optional(),
    }).parse(request.query);
    const today = istanbulTodayDate();
    const singleDate = parsed.date ?? null;

    // YP0.2: cache key (singleDate || today-future:<today>). 250 paralel istek
    // aynı key için tek compute() Promise paylaşır; TTL içinde DB query yok.
    const cacheKey = singleDate ? `date:${singleDate}` : `today-future:${today}`;

    return restoreMissingCache.getOrCompute(cacheKey, async () => {
      const channelOrder = new Map(PROVYS_CHANNELS.map((c, i) => [c.slug, i]));
      const channelDisplay = new Map(PROVYS_CHANNELS.map((c) => [c.slug, c.displayName]));

      const perChannel = await Promise.all(
        PROVYS_CHANNELS.map(async (c) => {
          try {
            return singleDate
              ? await fetchChannelDateSnapshot(app, c.slug, singleDate)
              : await fetchChannelTodayFutureSnapshot(app, c.slug, today);
          } catch (err) {
            app.log.warn({ err, channelSlug: c.slug, scope: singleDate ?? 'today-future' }, 'restore-missing: kanal snapshot fail');
            return [] as ProvysItemDto[];
          }
        }),
      );

      type RestoreRow = {
        channelSlug: string;
        channelDisplayName: string;
        scheduleDate: string;
        startTimecode: string | null;
        startAt: string;
        dcCode: string;
        title: string;
        seriesName: string | null;
        durationTimecode: string | null;
        category: string;
        rawKind: string | null;
        eventId: string;
        ssdbStatus: string;
        ssdbLabel: string;
        /** SSDB cache satirinin son kontrol zamani (ISO). UI "Son kontrol: X dk once"
         *  badge'i icin; null ise hic kontrol edilmemis (cache miss). */
        lastCheckedAt: string | null;
      };
      const rows: RestoreRow[] = [];
      for (let ci = 0; ci < perChannel.length; ci++) {
        const channelSlug = PROVYS_CHANNELS[ci].slug;
        for (const it of perChannel[ci]) {
          if (it.rawKind === 'ProgramHeader') continue;
          if (it.category === 'CANLI') continue;
          const dc = (it.dcCode ?? '').trim();
          if (dc.length === 0) continue;
          if (it.ssdb?.materialStatus !== 'missing_material') continue;
          rows.push({
            channelSlug,
            channelDisplayName: channelDisplay.get(channelSlug) ?? channelSlug,
            scheduleDate: it.scheduleDate,
            startTimecode: it.startTimecode,
            startAt: it.startAt,
            dcCode: dc,
            title: it.title,
            seriesName: it.seriesName,
            durationTimecode: it.durationTimecode,
            category: it.category,
            rawKind: it.rawKind,
            eventId: it.eventId,
            ssdbStatus: it.ssdb.materialStatus,
            ssdbLabel: it.ssdb.statusLabel,
            lastCheckedAt: it.ssdb.lastCheckedAt,
          });
        }
      }

      // Sıralama: today-future scope'da scheduleDate primary; tek gün scope'da
      // tüm satırlar aynı tarih olduğundan startAt primary olur (eski davranış).
      rows.sort((a, b) => {
        if (a.scheduleDate !== b.scheduleDate) return a.scheduleDate.localeCompare(b.scheduleDate);
        const ta = Date.parse(a.startAt);
        const tb = Date.parse(b.startAt);
        if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
        const ca = channelOrder.get(a.channelSlug) ?? 99;
        const cb = channelOrder.get(b.channelSlug) ?? 99;
        if (ca !== cb) return ca - cb;
        return (a.startTimecode ?? '').localeCompare(b.startTimecode ?? '');
      });

      return { date: singleDate ?? today, scope: singleDate ? 'single-date' : 'today-future', rows };
    });
  });

  // GET /api/v1/provys/dates?channel=<slug>
  // O kanal için DB'de bulunan tüm yayın günlerini (en yeniden eskiye) döner.
  app.get('/dates', {
    preHandler: app.requireGroup(...PERMISSIONS.provys.read),
    schema: { tags: ['Provys'], summary: 'Kanal için mevcut yayın günleri' },
  }, async (request: FastifyRequest) => {
    const parsed = channelQuerySchema.parse(request.query);
    const rows = await app.prisma.provysItem.findMany({
      where: { channelSlug: parsed.channel },
      select: { scheduleDate: true },
      distinct: ['scheduleDate'],
      orderBy: { scheduleDate: 'desc' },
    });
    return rows.map((r) => dateToIso(r.scheduleDate));
  });

  // GET /api/v1/provys/stream — SSE
  // Native EventSource Authorization header setleyemez → client tarafında
  // fetch-streaming reader (Bearer JWT). Token query param'a YAZILMAZ.
  // SSE sadece update + heartbeat yayar; initial snapshot REST `/items`.
  // Client kendi state'inde aktif (channel, date) filtreleyerek uygular.
  app.get('/stream', {
    preHandler: app.requireGroup(...PERMISSIONS.provys.read),
    config: { rateLimit: false },
    schema: { tags: ['Provys'], summary: 'Akış değişiklik bildirimleri (SSE)' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const databaseUrl = process.env.DATABASE_URL ?? '';
    if (!databaseUrl) {
      return reply.code(500).send({ message: 'DATABASE_URL set edilmemiş' });
    }

    reply.raw.statusCode = 200;
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders?.();

    const writeEvent = (event: ProvysStreamEvent): void => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const writeComment = (text: string): void => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`: ${text}\n\n`);
    };

    const listener = getProvysPgListener(databaseUrl, app.log);
    let unsubscribe: (() => Promise<void>) | null = null;
    try {
      unsubscribe = await listener.subscribe((payload) => {
        const channelSlug = payload.channelSlug;
        const scheduleDate = payload.scheduleDate;
        if (!channelSlug || !scheduleDate || !ISO_DATE_RE.test(scheduleDate)) return;
        fetchChannelDateSnapshot(app, channelSlug, scheduleDate)
          .then((items) => writeEvent({
            type: 'update',
            channel: channelSlug as ProvysItemDto['channelSlug'],
            scheduleDate,
            items,
          }))
          .catch((err) => app.log.warn({ err, payload }, 'Provys SSE: snapshot fetch hatası'));
      });
    } catch (err) {
      app.log.error({ err }, 'Provys SSE: pg listener subscribe hatası');
      reply.raw.end();
      return;
    }

    const heartbeatMs = Number(process.env.PROVYS_SSE_HEARTBEAT_MS ?? '25000');
    const heartbeat = setInterval(() => {
      writeComment('hb');
      writeEvent({ type: 'heartbeat', ts: Date.now() });
    }, heartbeatMs);
    heartbeat.unref();

    const cleanup = async (): Promise<void> => {
      clearInterval(heartbeat);
      if (unsubscribe) {
        try { await unsubscribe(); } catch (err) {
          app.log.warn({ err }, 'Provys SSE: listener cleanup hatası');
        }
        unsubscribe = null;
      }
    };

    request.raw.on('close', () => { void cleanup(); });
    reply.raw.on('close', () => { void cleanup(); });
    request.raw.on('error', () => { void cleanup(); });

    reply.hijack();
  });

  app.addHook('onClose', async () => {
    await closeProvysPgListener();
  });
}
