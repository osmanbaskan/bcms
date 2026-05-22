import { PROVYS_CATEGORIES, type ProvysCategory } from '@bcms/shared';

/**
 * Provys / BXF içerik türünden BCMS kategorisine dönüşüm — tek merkez.
 * Magic string'lerin route handler veya UI'a dağılmamasını sağlar.
 *
 * Sözleşme: Provys BXF dosyaları `<EventType>` veya `<ContentClass>`
 * field'ında raw tür taşır (örn. "COMMERCIAL", "PROMO", "LIVE", "PSA",
 * "PROGRAM", "PROMO_TRAILER"). Bilinmeyen → DIGER (silent fallback).
 *
 * Pattern bazlı: case-insensitive substring lookup tablosu. Sıra önemli
 * — daha spesifik kategoriler önce sınanır (örn. "KAMU SPOTU" → KAMU_SPOTU
 * "PROMO" → TANITIM çakışmasını önlemek için PSA/PUBLIC önce gelir).
 */
const PATTERN_TABLE: ReadonlyArray<{ patterns: string[]; category: ProvysCategory }> = [
  // KAMU_SPOTU — PSA, public service announcement, kamu spotu
  { patterns: ['kamu spotu', 'kamuspot', 'psa', 'public service', 'public_service'], category: 'KAMU_SPOTU' },
  // CANLI — live, naklen
  { patterns: ['canli', 'canlı', 'live', 'naklen'], category: 'CANLI' },
  // REKLAM — commercial, advertisement, reklam, paid program (infomercial).
  // "paid program" Provys'te ücretli reklam programı (sponsorlu yayın); UI'da
  // REKLAM olarak sınıflandırılması istendi. Sıra REKLAM > PROGRAM olduğu için
  // "paid program" PROGRAM substring eşleşmesinden önce yakalanır.
  { patterns: ['reklam', 'commercial', 'advert', 'spot reklam', 'paid program'], category: 'REKLAM' },
  // TANITIM — promo, tanitim, trailer, bumper, jingle
  { patterns: ['tanitim', 'tanıtım', 'promo', 'trailer', 'bumper', 'jingle', 'teaser'], category: 'TANITIM' },
  // PROGRAM — program, episode, dizi, film, mac
  { patterns: ['program', 'episode', 'movie', 'film', 'show', 'series', 'dizi', 'mac', 'maç'], category: 'PROGRAM' },
];

const NORMALIZED_CATEGORY_SET = new Set<string>(PROVYS_CATEGORIES);

/**
 * Pure: ham (Provys/BXF) tür string'ini BCMS kategorisine eşler.
 * Boş/null/bilinmeyen → 'DIGER'.
 *
 * @param rawKind Provys event/content tipi (BXF EventType veya ContentClass).
 */
export function classifyCategory(rawKind: string | null | undefined): ProvysCategory {
  if (!rawKind) return 'DIGER';
  const normalized = rawKind.trim().toLowerCase();
  if (!normalized) return 'DIGER';

  // Doğrudan kategori adı geldiyse (örn. zaten "REKLAM"), pass-through.
  const upper = normalized.toUpperCase().replace(/[\s-]+/g, '_');
  if (NORMALIZED_CATEGORY_SET.has(upper)) {
    return upper as ProvysCategory;
  }

  for (const entry of PATTERN_TABLE) {
    if (entry.patterns.some((p) => normalized.includes(p))) {
      return entry.category;
    }
  }
  return 'DIGER';
}
