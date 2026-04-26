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
    read:          [] as BcmsGroup[],            // all authenticated users
    edit:          ['SystemEng'] as BcmsGroup[], // düzenle butonu
    technicalEdit: ['SystemEng'] as BcmsGroup[], // teknik detay butonu
    duplicate:     ['SystemEng'] as BcmsGroup[], // çoğaltma butonu
    delete:        ['SystemEng'] as BcmsGroup[], // silme butonu
    write:         ['SystemEng'] as BcmsGroup[], // API write (edit+technicalEdit+duplicate union)
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
