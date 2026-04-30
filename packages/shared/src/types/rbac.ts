export const BCMS_GROUPS = [
  'Admin',
  'Tekyon',
  'Transmisyon',
  'Booking',
  'YayınPlanlama',
  'SystemEng',
  'Ingest',
  'Kurgu',
  'MCR',
  'PCR',
  'Ses',
  'StudyoSefi',
] as const;

export type BcmsGroup = typeof BCMS_GROUPS[number];

/** Canonical group constants — use instead of literal strings. */
export const GROUP = {
  Admin: 'Admin',
  Tekyon: 'Tekyon',
  Transmisyon: 'Transmisyon',
  Booking: 'Booking',
  YayınPlanlama: 'YayınPlanlama',
  SystemEng: 'SystemEng',
  Ingest: 'Ingest',
  Kurgu: 'Kurgu',
  MCR: 'MCR',
  PCR: 'PCR',
  Ses: 'Ses',
  StudyoSefi: 'StudyoSefi',
} as const satisfies Record<BcmsGroup, BcmsGroup>;

export interface JwtPayload {
  sub: string;
  preferred_username: string;
  email: string;
  groups: string[];
  iat: number;
  exp: number;
}

/** Permissions matrix — groups allowed for each action.
 *
 *  ## Yetki Modeli (2026-05-01 itibariyle)
 *
 *  - **Admin**: tüm endpoint'lerde bypass (auth.ts isAdminPrincipal). Tek "full yetki" grubu.
 *  - **SystemEng**: sadece operasyonel sekmelerde (audit, kullanıcılar, ayarlar, kanallar,
 *    monitoring, incidents, ingest). Canlı yayın / studio plan / raporlama / bookings /
 *    weekly-shift admin yetkilerinden çıkarıldı — kendi grubu = Tekyon vb. davranışına
 *    benzer kısıtlı kullanıcı.
 *  - Diğer gruplar: kendi rollerinin gerektirdiği endpoint'lerde explicit listelenir.
 */
export const PERMISSIONS = {
  schedules: {
    read:          [] as BcmsGroup[],                                                                  // all authenticated (izleme her grupta)
    add:           ['Booking', 'YayınPlanlama'] as BcmsGroup[],                                        // yeni ekle butonu
    edit:          ['Tekyon', 'Transmisyon', 'Booking', 'YayınPlanlama'] as BcmsGroup[],               // düzenle
    technicalEdit: ['Transmisyon', 'Booking'] as BcmsGroup[],                                          // teknik detay
    duplicate:     ['Tekyon', 'Transmisyon', 'Booking'] as BcmsGroup[],                                // çoğaltma
    delete:        ['Tekyon', 'Transmisyon', 'Booking', 'YayınPlanlama'] as BcmsGroup[],               // silme
    write:         ['Tekyon', 'Transmisyon', 'Booking', 'YayınPlanlama'] as BcmsGroup[],               // API PATCH/POST
  },
  bookings: {
    read:   [] as BcmsGroup[],
    write:  [] as BcmsGroup[],
    delete: [] as BcmsGroup[],
  },
  ingest: {
    read:         ['SystemEng', 'Ingest'] as BcmsGroup[],
    write:        ['SystemEng', 'Ingest'] as BcmsGroup[],
    delete:       ['SystemEng', 'Ingest'] as BcmsGroup[],
    reportIssue:  [] as BcmsGroup[],                       // tüm authenticated — her rol yayın sorunu bildirebilir
  },
  channels: {
    read:   ['SystemEng'] as BcmsGroup[],
    write:  ['SystemEng'] as BcmsGroup[],
    delete: ['SystemEng'] as BcmsGroup[],
  },
  incidents: {
    read:        ['SystemEng'] as BcmsGroup[],
    write:       ['SystemEng'] as BcmsGroup[],
    delete:      ['SystemEng'] as BcmsGroup[],
    reportIssue: ['SystemEng', 'Tekyon', 'Transmisyon'] as BcmsGroup[],
  },
  monitoring: {
    read:   ['SystemEng'] as BcmsGroup[],
    write:  ['SystemEng'] as BcmsGroup[],
  },
  auditLogs: {
    read:   ['SystemEng'] as BcmsGroup[],
  },
  reports: {
    read:   ['Admin'] as BcmsGroup[],                     // SystemEng dahil non-Admin grupları görmesin
    export: ['Admin'] as BcmsGroup[],
  },
  studioPlans: {
    read:   [] as BcmsGroup[],                             // all authenticated (liste görüntüleme)
    write:  ['StudyoSefi'] as BcmsGroup[],                 // SystemEng OUT — sadece StudyoSefi düzenler
    delete: ['StudyoSefi'] as BcmsGroup[],
  },
  weeklyShifts: {
    read:  [] as BcmsGroup[],
    write: [] as BcmsGroup[],
    admin: ['Admin'] as BcmsGroup[],                       // "tüm grupları gör" yetkisi sadece Admin'de
  },
} as const;
