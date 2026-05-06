import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Madde 5 M5-B9 (scope lock U9, 2026-05-07): live_plan_technical_details
 * üzerindeki 47 lookup FK alanı için active/deleted validation.
 *
 * Strateji:
 *   - Aynı tabloya birden fazla FK varsa (örn. transmission_irds → ird1/ird2/ird3
 *     veya technical_companies → 6 FK) tek `WHERE id IN (...)` sorgusu yapılır
 *     (47 sorgu yerine 25 sorgu max).
 *   - Her satır `active=true AND deletedAt IS NULL` kontrol edilir.
 *   - İhlal: `{ field, message }` listesi döner; service 400 fırlatır.
 *   - DB FK referansı sağlam — burada sadece **policy** kontrolü (active/deleted).
 *     Bilinmeyen ID için DB FK violation P2003 ayrı yolla yakalanır.
 *
 * `index.d.ts` Prisma client delegate'leri uniform interface (id PK, active,
 * deletedAt). 25 lookup tablo aynı shape'i karşılar.
 */

type LookupDelegateName =
  | 'transmissionSatellite' | 'transmissionIrd' | 'transmissionFiber'
  | 'transmissionIntResource' | 'transmissionTieOption' | 'transmissionDemodOption'
  | 'transmissionVirtualResource' | 'transmissionFeedType' | 'transmissionModulationType'
  | 'transmissionVideoCoding' | 'transmissionAudioConfig' | 'transmissionKeyType'
  | 'transmissionPolarization' | 'transmissionFecRate' | 'transmissionRollOff'
  | 'transmissionIsoFeedOption' | 'technicalCompany' | 'livePlanEquipmentOption'
  | 'livePlanLocation' | 'livePlanUsageLocation' | 'livePlanRegion'
  | 'livePlanLanguage' | 'livePlanOffTubeOption' | 'fiberAudioFormat'
  | 'fiberVideoFormat';

interface FieldRef {
  field:    string;        // dto field name (e.g. 'satelliteId')
  delegate: LookupDelegateName;
}

/** 47 FK alanı → Prisma delegate eşlemesi. */
const FIELD_REGISTRY: readonly FieldRef[] = [
  // §5.1 Yayın/OB grubu
  { field: 'broadcastLocationId',   delegate: 'livePlanLocation' },
  { field: 'obVanCompanyId',        delegate: 'technicalCompany' },
  { field: 'generatorCompanyId',    delegate: 'technicalCompany' },
  { field: 'jimmyJibId',            delegate: 'livePlanEquipmentOption' },
  { field: 'steadicamId',           delegate: 'livePlanEquipmentOption' },
  { field: 'sngCompanyId',          delegate: 'technicalCompany' },
  { field: 'carrierCompanyId',      delegate: 'technicalCompany' },
  { field: 'ibmId',                 delegate: 'livePlanEquipmentOption' },
  { field: 'usageLocationId',       delegate: 'livePlanUsageLocation' },
  { field: 'secondObVanId',         delegate: 'technicalCompany' },
  { field: 'regionId',              delegate: 'livePlanRegion' },
  // §5.2 Ortak
  { field: 'hdvgResourceId',        delegate: 'transmissionIntResource' },
  { field: 'int1ResourceId',        delegate: 'transmissionIntResource' },
  { field: 'int2ResourceId',        delegate: 'transmissionIntResource' },
  { field: 'offTubeId',             delegate: 'livePlanOffTubeOption' },
  { field: 'languageId',            delegate: 'livePlanLanguage' },
  { field: 'demodId',               delegate: 'transmissionDemodOption' },
  { field: 'tieId',                 delegate: 'transmissionTieOption' },
  { field: 'virtualResourceId',     delegate: 'transmissionVirtualResource' },
  // §5.3 IRD/Fiber
  { field: 'ird1Id',                delegate: 'transmissionIrd' },
  { field: 'ird2Id',                delegate: 'transmissionIrd' },
  { field: 'ird3Id',                delegate: 'transmissionIrd' },
  { field: 'fiber1Id',              delegate: 'transmissionFiber' },
  { field: 'fiber2Id',              delegate: 'transmissionFiber' },
  // §5.4 Ana Feed
  { field: 'feedTypeId',            delegate: 'transmissionFeedType' },
  { field: 'satelliteId',           delegate: 'transmissionSatellite' },
  { field: 'uplinkPolarizationId',  delegate: 'transmissionPolarization' },
  { field: 'downlinkPolarizationId',delegate: 'transmissionPolarization' },
  { field: 'modulationTypeId',      delegate: 'transmissionModulationType' },
  { field: 'rollOffId',             delegate: 'transmissionRollOff' },
  { field: 'videoCodingId',         delegate: 'transmissionVideoCoding' },
  { field: 'audioConfigId',         delegate: 'transmissionAudioConfig' },
  { field: 'isoFeedId',             delegate: 'transmissionIsoFeedOption' },
  { field: 'keyTypeId',             delegate: 'transmissionKeyType' },
  { field: 'fecRateId',             delegate: 'transmissionFecRate' },
  // §5.5 Yedek Feed
  { field: 'backupFeedTypeId',           delegate: 'transmissionFeedType' },
  { field: 'backupSatelliteId',          delegate: 'transmissionSatellite' },
  { field: 'backupUplinkPolarizationId', delegate: 'transmissionPolarization' },
  { field: 'backupDownlinkPolarizationId',delegate: 'transmissionPolarization' },
  { field: 'backupModulationTypeId',     delegate: 'transmissionModulationType' },
  { field: 'backupRollOffId',            delegate: 'transmissionRollOff' },
  { field: 'backupVideoCodingId',        delegate: 'transmissionVideoCoding' },
  { field: 'backupAudioConfigId',        delegate: 'transmissionAudioConfig' },
  { field: 'backupKeyTypeId',            delegate: 'transmissionKeyType' },
  { field: 'backupFecRateId',            delegate: 'transmissionFecRate' },
  // §5.6 Fiber
  { field: 'fiberCompanyId',        delegate: 'technicalCompany' },
  { field: 'fiberAudioFormatId',    delegate: 'fiberAudioFormat' },
  { field: 'fiberVideoFormatId',    delegate: 'fiberVideoFormat' },
];

export interface LookupValidationIssue {
  field:   string;
  id:      number;
  message: string;
}

interface UniformDelegate {
  findMany: (args: { where: Record<string, unknown> }) => Promise<Array<{ id: number; active: boolean; deletedAt: Date | null }>>;
}

/**
 * Body içindeki lookup FK alanları için active/deleted validation.
 * - undefined alan: skip (PATCH undefined=no change)
 * - null alan: skip (clear; FK NULL set ediliyor — validate gerek yok)
 * - sayı: aday liste, type-grouped fetch + kontrol
 */
export async function validateLookupFields(
  prisma: PrismaClient | Prisma.TransactionClient,
  body: Record<string, unknown>,
): Promise<LookupValidationIssue[]> {
  // 1. Alan → ID toplama (skip undefined / null)
  const candidates: Array<{ field: string; id: number; delegate: LookupDelegateName }> = [];
  for (const ref of FIELD_REGISTRY) {
    const value = body[ref.field];
    if (typeof value !== 'number') continue; // undefined / null skip
    candidates.push({ field: ref.field, id: value, delegate: ref.delegate });
  }
  if (candidates.length === 0) return [];

  // 2. Delegate başına grup
  const byDelegate = new Map<LookupDelegateName, Set<number>>();
  for (const c of candidates) {
    const set = byDelegate.get(c.delegate) ?? new Set<number>();
    set.add(c.id);
    byDelegate.set(c.delegate, set);
  }

  // 3. Tek sorgu/group → aktif id seti
  const okIds = new Map<LookupDelegateName, Set<number>>();
  for (const [delegate, ids] of byDelegate.entries()) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (prisma as any)[delegate] as UniformDelegate;
    const rows = await d.findMany({
      where: {
        id:        { in: Array.from(ids) },
        active:    true,
        deletedAt: null,
      },
    });
    okIds.set(delegate, new Set(rows.map((r) => r.id)));
  }

  // 4. Issue tespit
  const issues: LookupValidationIssue[] = [];
  for (const c of candidates) {
    if (!okIds.get(c.delegate)?.has(c.id)) {
      issues.push({
        field:   c.field,
        id:      c.id,
        message: `Lookup id=${c.id} aktif değil veya silinmiş (alan: ${c.field})`,
      });
    }
  }
  return issues;
}
