export type BcmsGroup =
  | 'Tekyon'
  | 'Transmisyon'
  | 'Booking'
  | 'YayınPlanlama'
  | 'SystemEng'
  | 'Ingest'
  | 'Kurgu'
  | 'MCR'
  | 'PCR'
  | 'Ses'
  | 'Studyo';

export interface JwtPayload {
  sub: string;
  preferred_username: string;
  email: string;
  groups: string[];
  iat: number;
  exp: number;
}

/** Permissions matrix — groups allowed for each action.
 *  Initially only SystemEng has access; update as department permissions are defined. */
export const PERMISSIONS = {
  schedules: {
    read:          [] as BcmsGroup[],                                                                      // all authenticated
    edit:          ['SystemEng', 'Tekyon', 'Transmisyon', 'Booking', 'YayınPlanlama'] as BcmsGroup[],     // düzenle
    technicalEdit: ['SystemEng', 'Transmisyon', 'Booking'] as BcmsGroup[],                                // teknik detay
    duplicate:     ['SystemEng', 'Tekyon', 'Transmisyon', 'Booking'] as BcmsGroup[],                      // çoğaltma
    delete:        ['SystemEng', 'Tekyon', 'Transmisyon', 'Booking', 'YayınPlanlama'] as BcmsGroup[],     // silme
    write:         ['SystemEng', 'Tekyon', 'Transmisyon', 'Booking', 'YayınPlanlama'] as BcmsGroup[],     // API PATCH/POST
  },
  bookings: {
    read:   ['SystemEng'] as BcmsGroup[],
    write:  ['SystemEng'] as BcmsGroup[],
    delete: ['SystemEng'] as BcmsGroup[],
  },
  ingest: {
    read:   ['SystemEng'] as BcmsGroup[],
    write:  ['SystemEng'] as BcmsGroup[],
    delete: ['SystemEng'] as BcmsGroup[],
  },
  channels: {
    read:   ['SystemEng'] as BcmsGroup[],
    write:  ['SystemEng'] as BcmsGroup[],
    delete: ['SystemEng'] as BcmsGroup[],
  },
  incidents: {
    read:   ['SystemEng'] as BcmsGroup[],
    write:  ['SystemEng'] as BcmsGroup[],
    delete: ['SystemEng'] as BcmsGroup[],
  },
  monitoring: {
    read:   ['SystemEng'] as BcmsGroup[],
    write:  ['SystemEng'] as BcmsGroup[],
  },
  auditLogs: {
    read:   ['SystemEng'] as BcmsGroup[],
  },
  reports: {
    read:   ['SystemEng'] as BcmsGroup[],
    export: ['SystemEng'] as BcmsGroup[],
  },
  studioPlans: {
    read:   ['SystemEng'] as BcmsGroup[],
    write:  ['SystemEng'] as BcmsGroup[],
    delete: ['SystemEng'] as BcmsGroup[],
  },
} as const;
