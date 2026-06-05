/**
 * Haber (NewsWorks / NRCS) modülü paylaşılan tipleri — 2026-06-05.
 *
 * EGS NewsWorks 2000 ("TV200P") yerine native newsroom. Terimler EGS'ten
 * korunur: Bülten (rundown), Haber (story), Spiker, KJ, SPOT.
 * Backend Zod şemaları + frontend servis bu tipleri ortak kullanır.
 */

export type NewsBulletinStatus = 'DRAFT' | 'READY' | 'ON_AIR' | 'DONE' | 'ARCHIVED';

/** Haberin Türü — EGS yapım nesneleri. */
export type NewsStoryType =
  | 'PKG'      // Paket (montajlı haber)
  | 'VO'       // Voice-over
  | 'VOSOT'    // VO + SOT
  | 'READER'   // Spiker okur (kuru anlatım)
  | 'LIVE'     // Canlı
  | 'PHONE'    // Telefon
  | 'CRAWL'    // Akan yazı (ticker)
  | 'ROLL';    // Jenerik / roll

export type NewsLowerThirdKind = 'KJ' | 'SPOT';
export type NewsWirePriority = 'FLASH' | 'NORMAL';
export type NewsMosDeviceKind = 'MOS_TCP' | 'VIZRT_REST' | 'XML_FILE';
export type NewsMosAction = 'KJ' | 'SPOT' | 'CRAWL' | 'ROLL';
export type NewsMosJobStatus = 'PENDING' | 'SENT' | 'FAILED';

/** KJ (chyron/lower-third) veya SPOT (altyazı): Başlık + 2 satır. */
export interface NewsLowerThird {
  id: number;
  storyId: number;
  kind: NewsLowerThirdKind;
  orderIndex: number;
  title: string | null;
  line1: string | null;
  line2: string | null;
}

/** Haber = story. bulletinId null → Haber Havuzu (story pool). */
export interface NewsStory {
  id: number;
  bulletinId: number | null;
  orderIndex: number;
  title: string;                 // Haber Adı
  displayName: string | null;    // Haber Görüntü Adı
  storyType: NewsStoryType;      // Haberin Türü
  clipDurationSec: number;       // Haber Bant Süresi (sn)
  anchorName: string | null;     // Spiker
  description: string | null;    // Açıklama
  prompterText: string | null;   // Prompter / spiker metni
  newsGroup: string | null;      // Haber Hattı Grubu
  locked: boolean;               // Haberi Koru
  lockedBy: string | null;
  version: number;
  createdBy: string;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  lowerThirds: NewsLowerThird[];
}

/** Bülten = günlük yayın akışı / rundown. */
export interface NewsBulletin {
  id: number;
  name: string;
  bulletinCode: string | null;
  bulletinDate: string;          // YYYY-MM-DD (Türkiye)
  onAirMinute: number;           // gün-dakikası (TZ-naive Türkiye)
  anchorName: string | null;     // Spiker
  newsGroup: string | null;
  status: NewsBulletinStatus;
  version: number;
  createdBy: string;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  storyCount?: number;
  totalDurationSec?: number;
  stories?: NewsStory[];
}

export interface NewsWireItem {
  id: number;
  source: string;                // AA | IHA | DHA | RSS | MANUAL
  externalId: string | null;
  category: string | null;
  priority: NewsWirePriority;
  headline: string;
  body: string | null;
  receivedAt: string;
  usedStoryId: number | null;
}

export interface NewsMosDevice {
  id: number;
  name: string;
  kind: NewsMosDeviceKind;
  host: string | null;
  port: number | null;
  mosId: string | null;
  ncsId: string | null;
  templateMap: Record<string, unknown> | null;
  active: boolean;
}

export interface NewsMosJob {
  id: number;
  storyId: number | null;
  lowerThirdId: number | null;
  deviceId: number | null;
  action: NewsMosAction;
  payloadXml: string | null;
  status: NewsMosJobStatus;
  attempts: number;
  error: string | null;
  sentAt: string | null;
  createdBy: string;
  createdAt: string;
}

// ---- DTO'lar (create / update / aksiyon) ----

export interface CreateBulletinDto {
  name: string;
  bulletinCode?: string | null;
  bulletinDate: string;          // YYYY-MM-DD
  onAirMinute: number;
  anchorName?: string | null;
  newsGroup?: string | null;
  status?: NewsBulletinStatus;
}
export type UpdateBulletinDto = Partial<CreateBulletinDto>;

export interface CreateStoryDto {
  bulletinId?: number | null;
  title: string;
  displayName?: string | null;
  storyType?: NewsStoryType;
  clipDurationSec?: number;
  anchorName?: string | null;
  description?: string | null;
  prompterText?: string | null;
  newsGroup?: string | null;
}
export type UpdateStoryDto = Partial<Omit<CreateStoryDto, 'bulletinId'>>;

export interface UpsertLowerThirdDto {
  id?: number;
  kind: NewsLowerThirdKind;
  orderIndex?: number;
  title?: string | null;
  line1?: string | null;
  line2?: string | null;
}

/** Bülten içi akış sırası (drag-reorder): sıralı story id listesi. */
export interface ReorderStoriesDto {
  orderedStoryIds: number[];
}

/** KJ/SPOT/CRAWL/ROLL "Yayına Gönder". deviceId yoksa dry-run (XML önizleme). */
export interface SendToAirDto {
  action: NewsMosAction;
  lowerThirdId?: number;
  deviceId?: number | null;
  dryRun?: boolean;
}

export interface SendToAirResult {
  job: NewsMosJob | null;
  previewXml: string;
  dryRun: boolean;
}

/** Ajans haberini havuz story'sine çevir. */
export interface WireToStoryDto {
  newsGroup?: string | null;
}
