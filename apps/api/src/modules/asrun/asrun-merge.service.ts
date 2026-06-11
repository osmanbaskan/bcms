/**
 * Asrun-Merge (2026-06-10) — "o gün GERÇEKTE ne yayınlandı" birleşik listesi.
 *
 * Sorun: playout router ile konuşmaz → canlı yayında asrun yanıltıcı (canlı
 * görünmez; playout'ta dönen başka materyal "yayınlanmış" görünür).
 *
 * Kurallar (Osman, 2026-06-10):
 *  - Provys CANLI blokları ÖNCE ve KİLİTLİ yazılır; merge yeniden koşsa da
 *    kilitli satırlara DOKUNULMAZ.
 *  - Asrun satırları kalan boşluklara eklenir; canlı pencereyle çakışan
 *    KIRPILIR (1-a), tamamen içindeki atlanır (yayınlanmadı).
 *  - Canlı gerçek sınırları "zincir tespiti": playout normal akışta materyali
 *    art arda (boşluksuz) oynatır → asrun kesintisiz aktığı an canlı bitmiştir.
 *    Simetrik: planlı başlangıçta zincir hâlâ akıyorsa canlı, zincir koptuğunda
 *    başlamıştır. Tespit yoksa plan sınırı + plan-bazlı bayrak.
 *  - İsim zenginleştirme: asrun'da isimsiz DC (boş ya da başlık==DC kod) →
 *    Provys'ten isim (DC unique → tek isim), titleSource=PROVYS.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@prisma/client';

// ── Ayarlar (env; gerçek veriyle kalibre edilebilir) ────────────────────────
export interface MergeOptions {
  /** İki asrun satırı arası bu boşluğa kadar "zincirli" sayılır (BXF yuvarlama payı). */
  gapToleranceMs: number;
  /** Zincirin "sürdürülebilir" sayılması için min toplam süre. */
  minChainMs: number;
  /** ... ve min satır sayısı (tek dolgu yanlış alarm vermesin). */
  minChainItems: number;
  /** Bitişik CANLI provys satırları bu boşluğa kadar TEK canlı blok sayılır. */
  clusterGapMs: number;
  /** Kırpma sonrası bu süreden kısa parçalar atılır. */
  minSegmentMs: number;
}

export function loadMergeOptions(env: NodeJS.ProcessEnv = process.env): MergeOptions {
  const n = (v: string | undefined, fb: number) => {
    const x = Number(v); return Number.isFinite(x) && x > 0 ? x : fb;
  };
  return {
    gapToleranceMs: n(env.ASRUN_MERGE_GAP_TOLERANCE_MS, 2_000),
    minChainMs:     n(env.ASRUN_MERGE_MIN_CHAIN_MS, 10 * 60_000),
    minChainItems:  n(env.ASRUN_MERGE_MIN_CHAIN_ITEMS, 2),
    clusterGapMs:   n(env.ASRUN_MERGE_CLUSTER_GAP_MS, 5 * 60_000),
    minSegmentMs:   n(env.ASRUN_MERGE_MIN_SEGMENT_MS, 1_000),
  };
}

// ── Saf fonksiyonlar (unit-testli; ms epoch aralıkları) ─────────────────────
export interface Interval { start: number; end: number }
export interface Chain extends Interval { items: number }

/** Sıralı asrun aralıklarından zincirleri kur (boşluk ≤ tolerans → aynı zincir). */
export function buildChains(items: Interval[], gapToleranceMs: number): Chain[] {
  const chains: Chain[] = [];
  for (const it of items) {
    if (it.end <= it.start) continue; // sıfır/negatif süre zincire girmez
    const last = chains[chains.length - 1];
    if (last && it.start - last.end <= gapToleranceMs) {
      last.end = Math.max(last.end, it.end);
      last.items += 1;
    } else {
      chains.push({ start: it.start, end: it.end, items: 1 });
    }
  }
  return chains;
}

/** Sürdürülebilir zincirler: toplam süre + satır sayısı eşiklerini geçenler. */
export function sustainedChains(chains: Chain[], opts: MergeOptions): Chain[] {
  return chains.filter((c) => c.end - c.start >= opts.minChainMs && c.items >= opts.minChainItems);
}

/** Bitişik/çakışan CANLI plan aralıklarını kümele (tek canlı blok). */
export function clusterIntervals(blocks: Interval[], clusterGapMs: number): Interval[] {
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.start - last.end <= clusterGapMs) last.end = Math.max(last.end, b.end);
    else out.push({ ...b });
  }
  return out;
}

export interface DetectedWindow extends Interval {
  startDetected: boolean;
  endDetected: boolean;
}

/**
 * Canlı bloğun GERÇEK penceresini tespit et.
 *  - Başlangıç: planlı başlangıçta sürdürülebilir zincir hâlâ akıyorsa →
 *    canlı, zincirin bittiği anda başlamıştır (S = zincir.end).
 *  - Bitiş: S'ten sonra başlayan İLK sürdürülebilir zincirin başlangıcı (E).
 *  - Tespit yoksa plan sınırı + bayrak false (UI 'plan bazlı ⚠').
 *  - horizonEnd: sonraki canlı bloğun planlı başlangıcı / +∞ (taşma karışmasın).
 */
export function detectLiveWindow(
  plan: Interval,
  sustained: Chain[],
  horizonEnd: number,
  opts: MergeOptions,
): DetectedWindow {
  let start = plan.start;
  let startDetected = false;
  const covering = sustained.find((c) => c.start <= plan.start && c.end > plan.start);
  if (covering && covering.end < horizonEnd) {
    start = covering.end;
    startDetected = true;
  }

  let end = Math.max(plan.end, start);
  let endDetected = false;
  const after = sustained.find((c) => c.start >= start && c.start < horizonEnd && c !== covering);
  if (after) {
    end = after.start;
    endDetected = true;
  }
  if (end > horizonEnd) end = horizonEnd;

  // Dejenere pencere → plana dön (bayraklar kapalı; UI uyarır).
  if (end <= start) {
    return { start: plan.start, end: Math.max(plan.end, plan.start + opts.minSegmentMs), startDetected: false, endDetected: false };
  }
  return { start, end, startDetected, endDetected };
}

/** Aralıktan pencere kümesini çıkar → kalan parçalar (kırpma). */
export function subtractWindows(item: Interval, windows: Interval[], minSegmentMs: number): Interval[] {
  let parts: Interval[] = [{ ...item }];
  for (const w of windows) {
    const next: Interval[] = [];
    for (const p of parts) {
      if (w.end <= p.start || w.start >= p.end) { next.push(p); continue; } // kesişmiyor
      if (w.start > p.start) next.push({ start: p.start, end: w.start });   // sol parça
      if (w.end < p.end)     next.push({ start: w.end, end: p.end });       // sağ parça
    }
    parts = next;
  }
  return parts.filter((p) => p.end - p.start >= minSegmentMs);
}

/** Asrun başlığı "isimsiz" mi? (boş ya da DC kodun kendisi) */
export function isTitleMissing(title: string | null | undefined, dcCode: string | null | undefined): boolean {
  const t = (title ?? '').trim();
  if (t === '') return true;
  return !!dcCode && t.toUpperCase() === dcCode.trim().toUpperCase();
}

// ── Merge builder (DB) ──────────────────────────────────────────────────────
export interface MergeBuildResult {
  channelSlug: string;
  date: string;
  liveBlocks: number;
  liveDetectedStarts: number;
  liveDetectedEnds: number;
  asrunInserted: number;
  asrunTrimmed: number;
  asrunSkipped: number;
  titlesEnriched: number;
  lockedReused: boolean;
}

/**
 * Bir kanal+gün için merge'i (yeniden) kur.
 *  - Kilitli CANLI satırlar varsa AYNEN korunur (pencereler onlardan okunur).
 *  - Yoksa: provys CANLI kümeleri + zincir tespiti → kilitli satırlar yazılır.
 *  - ASRUN-kökenli satırlar her koşulda silinip yeniden üretilir (idempotent).
 *
 * EŞZAMANLILIK (2026-06-11 fix): aynı (kanal,gün) için iki eşzamanlı çağrı
 * delete+insert yarışıyla MÜKERRER satır üretiyordu (ilk gece koşusunda
 * worker-recreate + dosya düşüşü çakışınca bs1/bs2/bs5'te yaşandı). Tüm iş
 * artık tek $transaction içinde ve girişte (kanal|gün) anahtarlı
 * pg_advisory_xact_lock alınır → çağrılar süreçler arası dahil SERİLEŞİR
 * (API rebuild + worker auto aynı anda gelse bile). Lock tx commit'te
 * kendiliğinden bırakılır.
 */
export async function buildAsrunMergeForDay(
  prisma: PrismaClient,
  channelSlug: string,
  dateIso: string,
  log: FastifyBaseLogger,
  opts: MergeOptions = loadMergeOptions(),
): Promise<MergeBuildResult> {
  return prisma.$transaction(
    (tx) => buildInTx(tx as PrismaClient, channelSlug, dateIso, log, opts),
    { maxWait: 15_000, timeout: 120_000 },
  );
}

async function buildInTx(
  prisma: PrismaClient,
  channelSlug: string,
  dateIso: string,
  log: FastifyBaseLogger,
  opts: MergeOptions,
): Promise<MergeBuildResult> {
  // Süreçler-arası serileştirme: aynı (kanal|gün) anahtarında tek inşaatçı.
  // $executeRaw: pg_advisory_xact_lock 'void' döner; $queryRaw deserialize
  // edemiyor (P2010) — executeRaw satır saymakla yetinir.
  await prisma.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`asrun-merge:${channelSlug}|${dateIso}`}))`;

  const day = new Date(`${dateIso}T00:00:00.000Z`);
  const res: MergeBuildResult = {
    channelSlug, date: dateIso, liveBlocks: 0, liveDetectedStarts: 0, liveDetectedEnds: 0,
    asrunInserted: 0, asrunTrimmed: 0, asrunSkipped: 0, titlesEnriched: 0, lockedReused: false,
  };

  // 1) Kaynaklar
  const asrunRows = await prisma.asrunItem.findMany({
    where: { channelSlug, scheduleDate: day },
    orderBy: [{ startAt: 'asc' }, { sequence: 'asc' }],
  });
  const provysCanli = await prisma.provysItem.findMany({
    where: { channelSlug, scheduleDate: day, category: 'CANLI' },
    orderBy: { startAt: 'asc' },
  });

  const asrunIv: (Interval & { row: typeof asrunRows[number] })[] = asrunRows.map((r) => ({
    start: r.startAt.getTime(),
    end: r.startAt.getTime() + Math.max(0, r.durationMs ?? 0),
    row: r,
  }));
  const chains = sustainedChains(buildChains(asrunIv, opts.gapToleranceMs), opts);

  // 2) Canlı pencereler — kilitli satır varsa ONLARDAN (dokunulmaz), yoksa tespit + yaz
  const existingLocked = await prisma.asrunMergeItem.findMany({
    where: { channelSlug, scheduleDate: day, locked: true },
    orderBy: { startAt: 'asc' },
  });

  let windows: Interval[];
  if (existingLocked.length > 0) {
    res.lockedReused = true;
    windows = clusterIntervals(
      existingLocked.map((r) => ({ start: r.startAt.getTime(), end: r.endAt.getTime() })),
      opts.clusterGapMs,
    );
    res.liveBlocks = windows.length;
  } else if (provysCanli.length > 0) {
    const planBlocks = provysCanli.map((p) => ({
      start: p.startAt.getTime(),
      end: p.startAt.getTime() + Math.max(0, p.durationMs ?? 0),
    }));
    const clusters = clusterIntervals(planBlocks, opts.clusterGapMs);
    res.liveBlocks = clusters.length;

    windows = [];
    for (let i = 0; i < clusters.length; i++) {
      const horizon = i + 1 < clusters.length ? clusters[i + 1].start : Number.POSITIVE_INFINITY;
      const w = detectLiveWindow(clusters[i], chains, horizon, opts);
      windows.push({ start: w.start, end: w.end });
      if (w.startDetected) res.liveDetectedStarts += 1;
      if (w.endDetected) res.liveDetectedEnds += 1;

      // Kümede yer alan provys satırları kilitli yazılır; küme sınır satırları
      // tespit edilen S/E'ye çekilir (gerçek yayın penceresi).
      const members = provysCanli.filter((p) => {
        const s = p.startAt.getTime();
        return s >= clusters[i].start - opts.clusterGapMs && s <= clusters[i].end + opts.clusterGapMs;
      });
      for (let m = 0; m < members.length; m++) {
        const p = members[m];
        const isFirst = m === 0;
        const isLast = m === members.length - 1;
        const rowStart = isFirst ? w.start : p.startAt.getTime();
        const rowEndPlan = p.startAt.getTime() + Math.max(0, p.durationMs ?? 0);
        const rowEnd = isLast ? w.end : rowEndPlan;
        if (rowEnd <= rowStart) continue; // dejenere (0 sn plan satırı küme içinde eridi)
        await prisma.asrunMergeItem.create({
          data: {
            channelSlug, scheduleDate: day,
            startAt: new Date(rowStart), endAt: new Date(rowEnd),
            durationMs: rowEnd - rowStart,
            dcCode: p.dcCode, title: p.title, titleSource: 'PROVYS',
            category: 'CANLI', origin: 'PROVYS_CANLI', locked: true,
            startDetected: isFirst ? w.startDetected : false,
            endDetected:   isLast ? w.endDetected : false,
            sourceProvysId: p.id,
          },
        });
      }
    }
  } else {
    windows = []; // canlı yok → merge = saf asrun kopyası (zenginleştirme yine çalışır)
  }

  // 3) ASRUN-kökenli satırları yeniden üret (kilitlilere dokunma)
  await prisma.asrunMergeItem.deleteMany({
    where: { channelSlug, scheduleDate: day, origin: 'ASRUN' },
  });

  // 3a) İsim zenginleştirme haritası — isimsiz DC'ler için Provys'ten (DC unique)
  const missingDc = Array.from(new Set(
    asrunRows.filter((r) => isTitleMissing(r.title, r.dcCode) && r.dcCode).map((r) => r.dcCode as string),
  ));
  const titleByDc = new Map<string, string>();
  if (missingDc.length > 0) {
    const provysTitles = await prisma.provysItem.findMany({
      where: { dcCode: { in: missingDc }, title: { not: '' } },
      orderBy: { updatedAt: 'desc' },
      select: { dcCode: true, title: true },
    });
    for (const t of provysTitles) {
      if (t.dcCode && !titleByDc.has(t.dcCode)) titleByDc.set(t.dcCode, t.title);
    }
  }

  // 3b) Kırpma + ekleme
  for (const iv of asrunIv) {
    if (iv.end <= iv.start) { res.asrunSkipped += 1; continue; }
    const parts = subtractWindows(iv, windows, opts.minSegmentMs);
    if (parts.length === 0) { res.asrunSkipped += 1; continue; } // tamamen canlı içinde → yayınlanmadı
    const wasTrimmed = parts.length > 1 || parts[0].start !== iv.start || parts[0].end !== iv.end;

    let title = iv.row.title;
    let titleSource: 'ASRUN' | 'PROVYS' = 'ASRUN';
    if (isTitleMissing(title, iv.row.dcCode) && iv.row.dcCode && titleByDc.has(iv.row.dcCode)) {
      title = titleByDc.get(iv.row.dcCode) as string;
      titleSource = 'PROVYS';
      res.titlesEnriched += 1;
    }

    for (const p of parts) {
      await prisma.asrunMergeItem.create({
        data: {
          channelSlug, scheduleDate: day,
          startAt: new Date(p.start), endAt: new Date(p.end),
          durationMs: p.end - p.start,
          dcCode: iv.row.dcCode, title, titleSource,
          category: iv.row.category, origin: 'ASRUN', locked: false,
          trimmed: wasTrimmed,
          sourceAsrunId: iv.row.id,
        },
      });
      res.asrunInserted += 1;
      if (wasTrimmed) res.asrunTrimmed += 1;
    }
  }

  log.info({ ...res }, 'Asrun-Merge kuruldu');
  return res;
}
