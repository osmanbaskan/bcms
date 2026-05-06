import { z } from 'zod';

/**
 * Madde 5 M5-B9 (scope lock U1-U12, 2026-05-07): live_plan_technical_details
 * Zod validators.
 *
 * U6: explicit POST + PATCH (no PUT upsert).
 * U7: PATCH partial — `.optional()` + lookup FK alanları `.nullable().optional()`.
 *     undefined → değiştirme; null → kolonu temizle; service explicit data builder.
 *
 * 73 domain alanı + version (schema'da yok; If-Match header'dan geliyor).
 */

const id        = z.number().int().positive();
const idNullable = z.number().int().positive().nullable();
const phone     = z.string().trim().min(1).max(80);
const phoneNullable = z.string().trim().min(1).max(80).nullable();
const txt       = (max: number) => z.string().trim().min(1).max(max);
const txtNullable = (max: number) => z.string().trim().min(1).max(max).nullable();

/**
 * Create body — tüm alanlar opsiyonel (1:1 child boş başlayabilir; operatör
 * sonradan tek tek doldurur). live_plan_entry_id URL param'dan gelir, body'de
 * yok.
 */
export const createTechnicalDetailsSchema = z.object({
  // §5.1 Yayın/OB grubu (14)
  broadcastLocationId:           id.optional(),
  obVanCompanyId:                id.optional(),
  generatorCompanyId:            id.optional(),
  jimmyJibId:                    id.optional(),
  steadicamId:                   id.optional(),
  sngCompanyId:                  id.optional(),
  carrierCompanyId:              id.optional(),
  ibmId:                         id.optional(),
  usageLocationId:               id.optional(),
  fixedPhone1:                   phone.optional(),
  secondObVanId:                 id.optional(),
  regionId:                      id.optional(),
  cameraCount:                   z.number().int().min(0).max(99).optional(),
  fixedPhone2:                   phone.optional(),
  // §5.2 Ortak (10)
  plannedStartTime:              z.string().datetime().optional(),
  plannedEndTime:                z.string().datetime().optional(),
  hdvgResourceId:                id.optional(),
  int1ResourceId:                id.optional(),
  int2ResourceId:                id.optional(),
  offTubeId:                     id.optional(),
  languageId:                    id.optional(),
  demodId:                       id.optional(),
  tieId:                         id.optional(),
  virtualResourceId:             id.optional(),
  // §5.3 IRD/Fiber (5)
  ird1Id:                        id.optional(),
  ird2Id:                        id.optional(),
  ird3Id:                        id.optional(),
  fiber1Id:                      id.optional(),
  fiber2Id:                      id.optional(),
  // §5.4 Ana Feed (21)
  feedTypeId:                    id.optional(),
  satelliteId:                   id.optional(),
  txp:                           txt(120).optional(),
  satChannel:                    txt(120).optional(),
  uplinkFrequency:               txt(120).optional(),
  uplinkPolarizationId:          id.optional(),
  downlinkFrequency:             txt(120).optional(),
  downlinkPolarizationId:        id.optional(),
  modulationTypeId:              id.optional(),
  rollOffId:                     id.optional(),
  videoCodingId:                 id.optional(),
  audioConfigId:                 id.optional(),
  preMatchKey:                   txt(200).optional(),
  matchKey:                      txt(200).optional(),
  postMatchKey:                  txt(200).optional(),
  isoFeedId:                     id.optional(),
  keyTypeId:                     id.optional(),
  symbolRate:                    txt(80).optional(),
  fecRateId:                     id.optional(),
  bandwidth:                     txt(80).optional(),
  uplinkFixedPhone:              phone.optional(),
  // §5.5 Yedek Feed (19)
  backupFeedTypeId:              id.optional(),
  backupSatelliteId:             id.optional(),
  backupTxp:                     txt(120).optional(),
  backupSatChannel:              txt(120).optional(),
  backupUplinkFrequency:         txt(120).optional(),
  backupUplinkPolarizationId:    id.optional(),
  backupDownlinkFrequency:       txt(120).optional(),
  backupDownlinkPolarizationId:  id.optional(),
  backupModulationTypeId:        id.optional(),
  backupRollOffId:               id.optional(),
  backupVideoCodingId:           id.optional(),
  backupAudioConfigId:           id.optional(),
  backupPreMatchKey:             txt(200).optional(),
  backupMatchKey:                txt(200).optional(),
  backupPostMatchKey:            txt(200).optional(),
  backupKeyTypeId:               id.optional(),
  backupSymbolRate:              txt(80).optional(),
  backupFecRateId:               id.optional(),
  backupBandwidth:               txt(80).optional(),
  // §5.6 Fiber (4)
  fiberCompanyId:                id.optional(),
  fiberAudioFormatId:            id.optional(),
  fiberVideoFormatId:            id.optional(),
  fiberBandwidth:                txt(80).optional(),
}).refine(
  (d) => {
    if (d.plannedStartTime && d.plannedEndTime) {
      return new Date(d.plannedEndTime) > new Date(d.plannedStartTime);
    }
    return true;
  },
  { message: 'plannedEndTime, plannedStartTime\'tan sonra olmalı', path: ['plannedEndTime'] },
);

export type CreateTechnicalDetailsDto = z.infer<typeof createTechnicalDetailsSchema>;

/**
 * Update body — tüm alanlar `.nullable().optional()` (U7: undefined=no change,
 * null=clear). En az 1 field.
 */
export const updateTechnicalDetailsSchema = z.object({
  broadcastLocationId:           idNullable.optional(),
  obVanCompanyId:                idNullable.optional(),
  generatorCompanyId:            idNullable.optional(),
  jimmyJibId:                    idNullable.optional(),
  steadicamId:                   idNullable.optional(),
  sngCompanyId:                  idNullable.optional(),
  carrierCompanyId:              idNullable.optional(),
  ibmId:                         idNullable.optional(),
  usageLocationId:               idNullable.optional(),
  fixedPhone1:                   phoneNullable.optional(),
  secondObVanId:                 idNullable.optional(),
  regionId:                      idNullable.optional(),
  cameraCount:                   z.number().int().min(0).max(99).nullable().optional(),
  fixedPhone2:                   phoneNullable.optional(),
  plannedStartTime:              z.string().datetime().nullable().optional(),
  plannedEndTime:                z.string().datetime().nullable().optional(),
  hdvgResourceId:                idNullable.optional(),
  int1ResourceId:                idNullable.optional(),
  int2ResourceId:                idNullable.optional(),
  offTubeId:                     idNullable.optional(),
  languageId:                    idNullable.optional(),
  demodId:                       idNullable.optional(),
  tieId:                         idNullable.optional(),
  virtualResourceId:             idNullable.optional(),
  ird1Id:                        idNullable.optional(),
  ird2Id:                        idNullable.optional(),
  ird3Id:                        idNullable.optional(),
  fiber1Id:                      idNullable.optional(),
  fiber2Id:                      idNullable.optional(),
  feedTypeId:                    idNullable.optional(),
  satelliteId:                   idNullable.optional(),
  txp:                           txtNullable(120).optional(),
  satChannel:                    txtNullable(120).optional(),
  uplinkFrequency:               txtNullable(120).optional(),
  uplinkPolarizationId:          idNullable.optional(),
  downlinkFrequency:             txtNullable(120).optional(),
  downlinkPolarizationId:        idNullable.optional(),
  modulationTypeId:              idNullable.optional(),
  rollOffId:                     idNullable.optional(),
  videoCodingId:                 idNullable.optional(),
  audioConfigId:                 idNullable.optional(),
  preMatchKey:                   txtNullable(200).optional(),
  matchKey:                      txtNullable(200).optional(),
  postMatchKey:                  txtNullable(200).optional(),
  isoFeedId:                     idNullable.optional(),
  keyTypeId:                     idNullable.optional(),
  symbolRate:                    txtNullable(80).optional(),
  fecRateId:                     idNullable.optional(),
  bandwidth:                     txtNullable(80).optional(),
  uplinkFixedPhone:              phoneNullable.optional(),
  backupFeedTypeId:              idNullable.optional(),
  backupSatelliteId:             idNullable.optional(),
  backupTxp:                     txtNullable(120).optional(),
  backupSatChannel:              txtNullable(120).optional(),
  backupUplinkFrequency:         txtNullable(120).optional(),
  backupUplinkPolarizationId:    idNullable.optional(),
  backupDownlinkFrequency:       txtNullable(120).optional(),
  backupDownlinkPolarizationId:  idNullable.optional(),
  backupModulationTypeId:        idNullable.optional(),
  backupRollOffId:               idNullable.optional(),
  backupVideoCodingId:           idNullable.optional(),
  backupAudioConfigId:           idNullable.optional(),
  backupPreMatchKey:             txtNullable(200).optional(),
  backupMatchKey:                txtNullable(200).optional(),
  backupPostMatchKey:            txtNullable(200).optional(),
  backupKeyTypeId:               idNullable.optional(),
  backupSymbolRate:              txtNullable(80).optional(),
  backupFecRateId:               idNullable.optional(),
  backupBandwidth:               txtNullable(80).optional(),
  fiberCompanyId:                idNullable.optional(),
  fiberAudioFormatId:            idNullable.optional(),
  fiberVideoFormatId:            idNullable.optional(),
  fiberBandwidth:                txtNullable(80).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'En az bir field güncellenmeli' })
  .refine(
    (d) => {
      if (d.plannedStartTime && d.plannedEndTime) {
        return new Date(d.plannedEndTime) > new Date(d.plannedStartTime);
      }
      return true;
    },
    { message: 'plannedEndTime, plannedStartTime\'tan sonra olmalı', path: ['plannedEndTime'] },
  );

export type UpdateTechnicalDetailsDto = z.infer<typeof updateTechnicalDetailsSchema>;
