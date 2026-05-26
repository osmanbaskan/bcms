import { GROUP, type BcmsGroup } from './rbac.js';

/**
 * Provys İçerik Kontrol — kanal kataloğu.
 *
 * `fileCode` Provys SMB dizinine düşen `.bxf` dosya adından çıkarılan
 * kod (örn. `ltv-2026-05-22.bxf` → `ltv`). `slug` UI/route/DB
 * kayıtlarında canonical kanal kimliğidir. Tek kaynak — backend
 * (kanal eşleştirme) ve frontend (tab başlığı/route) ortak kullanır.
 */
export interface ProvysChannel {
  readonly fileCode: string;
  readonly slug: string;
  readonly displayName: string;
}

export const PROVYS_CHANNELS: readonly ProvysChannel[] = [
  { fileCode: 'ltv',  slug: 'beinsports1', displayName: 'beIN Sports 1' },
  { fileCode: 'lt2',  slug: 'beinsports2', displayName: 'beIN Sports 2' },
  { fileCode: 'lt3',  slug: 'beinsports3', displayName: 'beIN Sports 3' },
  { fileCode: 'lt4',  slug: 'beinsports4', displayName: 'beIN Sports 4' },
  { fileCode: 'lt5',  slug: 'beinsports5', displayName: 'beIN Sports 5' },
  { fileCode: 'xsnw', slug: 'beinhaber',   displayName: 'beIN Haber'    },
] as const;

export const PROVYS_CHANNEL_SLUGS = PROVYS_CHANNELS.map((c) => c.slug);
export type ProvysChannelSlug = (typeof PROVYS_CHANNELS)[number]['slug'];

/**
 * Akış kalemi kategorisi. Renkler ve sınıflandırma mantığı tek
 * merkezdedir; route handler veya UI içinde literal kullanmayın.
 */
export const PROVYS_CATEGORIES = ['REKLAM', 'KAMU_SPOTU', 'CANLI', 'PROGRAM', 'TANITIM', 'DIGER'] as const;
export type ProvysCategory = (typeof PROVYS_CATEGORIES)[number];

/**
 * Kategori → renk tek kaynak. Backend ve frontend ikisi de buradan
 * okur; magic string dağılmaz. Renkler operasyon ekranı tonlarında —
 * mevcut design token paletiyle uyumlu, satır background tint için.
 */
export interface ProvysCategoryStyle {
  readonly label: string;
  readonly background: string;
  readonly border: string;
  readonly text: string;
}

export const PROVYS_CATEGORY_STYLES: Record<ProvysCategory, ProvysCategoryStyle> = {
  REKLAM:     { label: 'Reklam',      background: '#fff4e5', border: '#f59e0b', text: '#7c2d12' },
  KAMU_SPOTU: { label: 'Kamu Spotu',  background: '#eef2ff', border: '#6366f1', text: '#312e81' },
  CANLI:      { label: 'Canlı',       background: '#fee2e2', border: '#dc2626', text: '#7f1d1d' },
  PROGRAM:    { label: 'Program',     background: '#ecfdf5', border: '#10b981', text: '#064e3b' },
  TANITIM:    { label: 'Tanıtım',     background: '#f3e8ff', border: '#a855f7', text: '#581c87' },
  DIGER:      { label: 'Diğer',       background: '#f3f4f6', border: '#9ca3af', text: '#374151' },
};

/**
 * SSE event tipleri. Worker → API LISTEN → client stream.
 *
 * Per-day snapshot semantiği (2026-05-22): event her zaman bir kanal+gün
 * çiftine ait olur. UI sadece aktif `(channel, date)` çiftine ait event'leri
 * uygular; başka günün update'i mevcut listeyi etkilemez.
 *
 * `snapshot`: bağlantı açıldığında ilk gelen tam liste (kanal+gün için).
 * `update`:   kanalın o güne ait güncel snapshot'ı (toplu replace).
 * `heartbeat`: idle keepalive.
 */
export type ProvysStreamEvent =
  | { type: 'snapshot';  channel: ProvysChannelSlug; scheduleDate: string; items: ProvysItemDto[] }
  | { type: 'update';    channel: ProvysChannelSlug; scheduleDate: string; items: ProvysItemDto[] }
  | { type: 'heartbeat'; ts: number };

/** `title` derived display alan — fallback chain'in hangi kaynaktan
 *  geldiğini gösterir. UI/reporting için ayrı saklanır.
 *  Migration öncesi yazılan kayıtlarda null. */
export type ProvysTitleSource =
  | 'VERSION_NAME'
  | 'EPISODE_NAME'
  | 'EVENT_TITLE'
  | 'CONTENT_NAME'
  | 'PROGRAM_NAME'
  | 'AD_TYPE_SPOT_TYPE'
  | 'UNKNOWN';

export interface ProvysItemDto {
  id: number;
  channelSlug: ProvysChannelSlug;
  /** Yayın günü, Europe/Istanbul naive tarih `YYYY-MM-DD`. */
  scheduleDate: string;
  eventId: string;
  sequence: number;
  startAt: string;                       // ISO-8601 Europe/Istanbul UTC instant
  durationMs: number | null;
  /** SMPTE timecode `HH:MM:SS:FF` (raw — frame korunur). Eski kayıtlar null. */
  startTimecode: string | null;
  /** SMPTE duration `HH:MM:SS:FF`. Eski kayıtlar null → `durationMs` fallback. */
  durationTimecode: string | null;
  /** SmpteDateTime / SmpteDuration @frameRate (genelde 25). */
  frameRate: number | null;
  /** Content > ContentId > HouseNumber (örn. "DC00041439"). */
  dcCode: string | null;
  /** Derived display title — fallback chain'in seçtiği metin. */
  title: string;
  rawKind: string | null;
  category: ProvysCategory;
  // 2026-05-26: BXF ham title kaynak alanları — `title` derived display alan
  // olarak kalır. Bu alanlar migration öncesi kayıtlarda null; watcher yeni
  // çalıştığında BXF reparse ile dolar. UI iki seviyeli görünüm (üst başlık
  // + alt başlık + metadata) ayrımı için kullanır.
  versionName: string | null;
  episodeName: string | null;
  eventTitle: string | null;
  contentName: string | null;
  programName: string | null;
  adType: string | null;
  spotType: string | null;
  titleSource: ProvysTitleSource | null;
  seriesName: string | null;
  episodeNumber: number | null;
  sourceFile: string;
  /** Kullanıcı serbest notu (BCMS UI tarafından PATCH ile yazılır). BXF
   *  parser/watcher bu alana dokunmaz; composed snapshot sync sırasında
   *  korunur. Export "Not" kolonu olarak bu değer kullanılır. */
  userNote: string | null;
  updatedAt: string;
  /** 2026-05-27: SSDB MAM materyal kontrol bilgisi (response-time computed).
   *  Her zaman dolu — `materialStatus` 8 değerli enum:
   *    `live_not_applicable` (CANLI), `missing_dc_code`, `unchecked`,
   *    `missing_material`, `found_match`, `found_duration_mismatch`,
   *    `found_duration_unknown`, `ssdb_error`.
   *  Cache okunmadıysa veya flag off ise `unchecked`/derived default döner. */
  ssdb: ProvysItemSsdbInfo;
}

/** DB cache `ssdb_material_cache.lookup_status` — raw SSDB lookup outcome. */
export type SsdbLookupStatus =
  | 'found'
  | 'missing_material'
  | 'duration_unknown'
  | 'ssdb_error';

/** UI material status — response-time computed; DB'ye yazılmaz.
 *  `dc_not_applicable` ve `live_not_applicable` SSDB kapsamı dışı kabul edilir
 *  (alarm üretmez; eksik filtreye dahil değildir). */
export type ProvysMaterialStatus =
  | 'live_not_applicable'
  | 'dc_not_applicable'
  | 'unchecked'
  | 'missing_material'
  | 'found_match'
  | 'found_duration_mismatch'
  | 'found_duration_unknown'
  | 'ssdb_error';

/** Resolver hangi yolla MEDIA satırını buldu (cache `match_method`). */
export type SsdbMatchMethod =
  | 'alias'
  | 'original_filename'
  | 'name_like';

/**
 * Provys row × SSDB cache karşılaştırması sonucu UI render bilgisi.
 * `materialStatus` 8 değerli enum; `statusLabel` backend-derived Türkçe metin.
 * CANLI satırlar için cache okunmaz ve cache alanları null döner.
 */
export interface ProvysItemSsdbInfo {
  /** Cache lookup_status; cache yok veya CANLI iken null. */
  lookupStatus: SsdbLookupStatus | null;
  /** Response-time hesaplanan UI status — render bunun üzerinden. */
  materialStatus: ProvysMaterialStatus;
  /** Türkçe label; UI direkt render eder. */
  statusLabel: string;
  mediaGuid: string | null;
  matchMethod: SsdbMatchMethod | null;
  ssdbDurationFrames: number | null;
  ssdbDurationTimecode: string | null;
  /** Backend response-time hesabı; mismatch tooltip için. */
  provysDurationFrames: number | null;
  /** Cache/row'dan gelen fps; UI render için. */
  frameRate: number | null;
  /** ISO-8601 instant; cache `last_checked_at`. */
  lastCheckedAt: string | null;
  lastError: string | null;
}

// PERMISSIONS.provys.read — Admin auto-bypass davranışı korunur,
// route'ta ayrıca listelenmez. Bkz. rbac.ts PERMISSIONS yapısı.
export const PROVYS_READ_GROUPS: readonly BcmsGroup[] = [
  GROUP.MCR,
  GROUP.PCR,
  GROUP.SystemEng,
  GROUP.YayınPlanlama,
];
