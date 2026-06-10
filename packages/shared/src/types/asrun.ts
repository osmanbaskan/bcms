import { GROUP, type BcmsGroup } from './rbac.js';
import {
  PROVYS_CHANNELS,
  PROVYS_CHANNEL_SLUGS,
  PROVYS_CATEGORIES,
  type ProvysChannelSlug,
  type ProvysCategory,
} from './provys.js';

/**
 * Asrun — playout SONRASI gerçekleşen yayın kaydı (as-run log). Provys
 * playlist'i (planlanan) ile aynı 6 kanal kataloğu paylaşılır; BCMS bunu
 * SMB üstünden ayrı bir Outbox/Ok dizininden ingest eder (worker tarafı:
 * `asrun-watcher`). Domain net ayrımı:
 *
 *   Provys   → planlanan yayın akışı / playlist snapshot. Composed
 *              latest-wins merge ile birden çok revize tek snapshot'a
 *              indirgenir; kullanıcı not yazabilir.
 *   Asrun    → gerçekleşen yayın kaydı. Event'ler tarih anında sabittir;
 *              composed merge gerekmez. Aynı eventId yeniden gelirse
 *              latest sourceMtime kazanır (idempotent upsert). Not
 *              özelliği V1'de yok.
 *
 * Kanal kataloğu paylaşıldığı için ayrı sabit listesi tanımlanmaz —
 * `PROVYS_CHANNELS` re-export edilir; isim ayrımı tip seviyesinde:
 * `AsrunChannelSlug` aynı union, sözleşme farklı domain'e işaret eder.
 */
export const ASRUN_CHANNELS = PROVYS_CHANNELS;
export const ASRUN_CHANNEL_SLUGS = PROVYS_CHANNEL_SLUGS;
export type AsrunChannelSlug = ProvysChannelSlug;

/** Asrun kalemleri Provys kategori sözleşmesini paylaşır (parser ortak). */
export const ASRUN_CATEGORIES = PROVYS_CATEGORIES;
export type AsrunCategory = ProvysCategory;

export interface AsrunItemDto {
  id: number;
  channelSlug: AsrunChannelSlug;
  /** Yayın günü, Europe/Istanbul naive tarih `YYYY-MM-DD`. */
  scheduleDate: string;
  eventId: string;
  sequence: number;
  startAt: string;                       // ISO-8601 UTC instant
  durationMs: number | null;
  /** SMPTE timecode `HH:MM:SS:FF` (raw — frame korunur). */
  startTimecode: string | null;
  /** SMPTE duration `HH:MM:SS:FF`. */
  durationTimecode: string | null;
  /** SmpteDateTime / SmpteDuration @frameRate (genelde 25). */
  frameRate: number | null;
  /** Content > ContentId > HouseNumber (örn. "DC00041439"). */
  dcCode: string | null;
  title: string;
  rawKind: string | null;
  category: AsrunCategory;
  sourceFile: string;
  updatedAt: string;
}

/**
 * Asrun-Merge (2026-06-10) — "o gün GERÇEKTE ne yayınlandı" birleşik satırı.
 * Provys CANLI blokları kilitli (origin=PROVYS_CANLI, locked=true; canlı
 * pencerede playout logu yanıltıcıdır); asrun satırları boşluk dolgusu
 * (origin=ASRUN; canlı pencereyle çakışanlar kırpılır → trimmed=true).
 * start/endDetected: canlı sınırı asrun "zincir tespiti" ile düzeltildi
 * (false = plan bazlı ⚠). titleSource=PROVYS → isimsiz DC kodu Provys'ten
 * zenginleştirildi (DC unique → tek isim).
 */
export type AsrunMergeOrigin = 'PROVYS_CANLI' | 'ASRUN';

export interface AsrunMergeItemDto {
  id: number;
  channelSlug: AsrunChannelSlug;
  scheduleDate: string;
  startAt: string;                       // ISO-8601 UTC instant
  endAt: string;
  durationMs: number;
  dcCode: string | null;
  title: string;
  titleSource: 'ASRUN' | 'PROVYS';
  category: AsrunCategory;
  origin: AsrunMergeOrigin;
  locked: boolean;
  trimmed: boolean;
  startDetected: boolean;
  endDetected: boolean;
}

/**
 * PERMISSIONS.asrun.read — V1 allowlist. ProvysViewer **dahil edilmez**;
 * ProvysViewer rolü yalnız Provys (planlanan akış) içerir. As-run kaydı
 * operatör ekipleri ve sistem mühendisliği için. Admin auto-bypass route
 * tarafında zaten uygulanır.
 */
export const ASRUN_READ_GROUPS: readonly BcmsGroup[] = [
  GROUP.MCR,
  GROUP.PCR,
  GROUP.SystemEng,
  GROUP.YayınPlanlama,
];
