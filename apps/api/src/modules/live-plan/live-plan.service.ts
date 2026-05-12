import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma, type LivePlanEntry } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { writeShadowEvent } from '../outbox/outbox.helpers.js';
import type {
  CreateLivePlanDto,
  ListLivePlanQuery,
  UpdateLivePlanDto,
} from './live-plan.schema.js';

/**
 * Madde 5 M5-B2 (decision §3.3): live-plan service.
 *
 * Locked invariants:
 * - K9 If-Match zorunlu (Schedule'dan bilinçli ayrışma).
 *   Schedule investigation showed If-Match is optional there. Live-plan
 *   intentionally requires it because this is a new API surface and K3
 *   optimistic locking must be enforced.
 * - K10 audit subject otomatik (Prisma model adından entityType="LivePlanEntry").
 * - K11 hard delete (2026-05-07 cleanup) — version-aware deleteMany, FK
 *   `onDelete: Cascade` ile child satırlar (technical_details + segments)
 *   aynı tx'te silinir. Lookup tabloları soft-delete pattern korur (lifecycle
 *   farklı). `deletedAt` kolon defansif filtre olarak kalır.
 * - K12 outbox shadow events: live_plan.created/updated/deleted; routing dışı
 *   (poller pick etmez — Phase 2 status='published').
 * - K14 response shape: Schedule pattern (entity DTO; list { items, total, page, pageSize }).
 *
 * Out of scope: route/UI, ingest FK, eski schedules cleanup, frontend.
 */

const SHADOW_AGGREGATE_TYPE = 'LivePlanEntry';

/**
 * 2026-05-11: Read response'a `leagueName` join'i — Lig OPTA değer (Match
 * relation üzerinden). Editable DEĞİL; write payload'a girmez. Migration yok.
 * Null'lar: matchId null veya match.league null senaryosu.
 *
 * Aynı tarihte (2026-05-11): list + detail response'unda `technicalDetails`
 * display objesi flatten edilir. 14 FK için (id + name) çiftleri; isimler
 * 10 farklı lookup tablosundan **batch fetch** ile resolve edilir (N+1 yok;
 * list boyutundan bağımsız 10 query). Prisma schema'da 47 FK için relation
 * tanımlı olmadığından (pragmatik tercih) include yerine ID toplama + tek
 * findMany pattern'i kullanılır.
 */
export interface TechnicalDetailsDisplay {
  modulationTypeId:     number | null; modulationTypeName:     string | null;
  videoCodingId:        number | null; videoCodingName:        string | null;
  ird1Id:               number | null; ird1Name:               string | null;
  ird2Id:               number | null; ird2Name:               string | null;
  ird3Id:               number | null; ird3Name:               string | null;
  fiber1Id:             number | null; fiber1Name:             string | null;
  fiber2Id:             number | null; fiber2Name:             string | null;
  demodId:              number | null; demodName:              string | null;
  tieId:                number | null; tieName:                string | null;
  virtualResourceId:    number | null; virtualResourceName:    string | null;
  hdvgResourceId:       number | null; hdvgResourceName:       string | null;
  int1ResourceId:       number | null; int1ResourceName:       string | null;
  int2ResourceId:       number | null; int2ResourceName:       string | null;
  offTubeId:            number | null; offTubeName:            string | null;
  languageId:           number | null; languageName:           string | null;
  secondLanguageId:     number | null; secondLanguageName:     string | null;
  /** 2026-05-12: Transmisyon süresi — list/detail response'unda gerçek ISO
   *  değerleriyle döner. Schedule-list "Transmisyon Başlangıç / Bitiş"
   *  kolonları bu alanlardan beslenir. UTC ISO; UI tarafı Türkiye saatine
   *  formatlar. Null = teknik detay satırı yok veya alan boş. */
  plannedStartTime:     string | null;
  plannedEndTime:       string | null;
}

export type LivePlanEntryWithLeague = LivePlanEntry & {
  leagueName:       string | null;
  technicalDetails: TechnicalDetailsDisplay | null;
};

const MATCH_LEAGUE_INCLUDE = {
  match: { include: { league: { select: { name: true } } } },
  technicalDetails: true,
} as const satisfies Prisma.LivePlanEntryInclude;

type EntryWithIncludes = Prisma.LivePlanEntryGetPayload<{ include: typeof MATCH_LEAGUE_INCLUDE }>;

function flattenLeagueOnly(row: EntryWithIncludes): { leagueName: string | null } {
  return { leagueName: row.match?.league?.name ?? null };
}

/**
 * 14 display alanı için (techRow → entry başına) name resolve. Lookup tablo
 * gruplaması: 10 distinct prisma delegate.
 *
 * Çağıran fonksiyon batch'i kuruyor; bu helper sadece map yapıyor.
 */
type NameMap = Map<number, string>;

interface NameMaps {
  modulationType: NameMap;
  videoCoding:    NameMap;
  ird:            NameMap;
  fiber:          NameMap;
  demod:          NameMap;
  tie:            NameMap;
  virtualResource:NameMap;
  intResource:    NameMap;
  offTube:        NameMap;
  language:       NameMap;
}

function emptyNameMaps(): NameMaps {
  return {
    modulationType: new Map(), videoCoding: new Map(), ird: new Map(),
    fiber: new Map(), demod: new Map(), tie: new Map(),
    virtualResource: new Map(), intResource: new Map(), offTube: new Map(),
    language: new Map(),
  };
}

function buildTechnicalDisplay(
  tech: EntryWithIncludes['technicalDetails'],
  names: NameMaps,
): TechnicalDetailsDisplay | null {
  if (!tech || tech.deletedAt !== null) return null;
  const m = (map: NameMap, id: number | null) => (id === null ? null : map.get(id) ?? null);
  return {
    modulationTypeId:    tech.modulationTypeId,
    modulationTypeName:  m(names.modulationType, tech.modulationTypeId),
    videoCodingId:       tech.videoCodingId,
    videoCodingName:     m(names.videoCoding, tech.videoCodingId),
    ird1Id:              tech.ird1Id, ird1Name: m(names.ird, tech.ird1Id),
    ird2Id:              tech.ird2Id, ird2Name: m(names.ird, tech.ird2Id),
    ird3Id:              tech.ird3Id, ird3Name: m(names.ird, tech.ird3Id),
    fiber1Id:            tech.fiber1Id, fiber1Name: m(names.fiber, tech.fiber1Id),
    fiber2Id:            tech.fiber2Id, fiber2Name: m(names.fiber, tech.fiber2Id),
    demodId:             tech.demodId, demodName: m(names.demod, tech.demodId),
    tieId:               tech.tieId, tieName: m(names.tie, tech.tieId),
    virtualResourceId:   tech.virtualResourceId,
    virtualResourceName: m(names.virtualResource, tech.virtualResourceId),
    hdvgResourceId:      tech.hdvgResourceId,
    hdvgResourceName:    m(names.intResource, tech.hdvgResourceId),
    int1ResourceId:      tech.int1ResourceId,
    int1ResourceName:    m(names.intResource, tech.int1ResourceId),
    int2ResourceId:      tech.int2ResourceId,
    int2ResourceName:    m(names.intResource, tech.int2ResourceId),
    offTubeId:           tech.offTubeId, offTubeName: m(names.offTube, tech.offTubeId),
    languageId:          tech.languageId, languageName: m(names.language, tech.languageId),
    secondLanguageId:    tech.secondLanguageId,
    secondLanguageName:  m(names.language, tech.secondLanguageId),
    plannedStartTime:    tech.plannedStartTime ? tech.plannedStartTime.toISOString() : null,
    plannedEndTime:      tech.plannedEndTime   ? tech.plannedEndTime.toISOString()   : null,
  };
}

export interface ListLivePlanResult {
  items:    LivePlanEntryWithLeague[];
  total:    number;
  page:     number;
  pageSize: number;
}

export class LivePlanService {
  constructor(private readonly app: FastifyInstance) {}

  // ── List ───────────────────────────────────────────────────────────────────
  async list(query: ListLivePlanQuery): Promise<ListLivePlanResult> {
    const where: Prisma.LivePlanEntryWhereInput = {
      deletedAt: null, // K11 defansif filter (hard-delete sonrası no-op)
      ...(query.status?.length ? { status: { in: query.status } } : {}),
      ...(query.matchId !== undefined ? { matchId: query.matchId } : {}),
      ...(query.optaMatchId !== undefined ? { optaMatchId: query.optaMatchId } : {}),
      ...this.buildDateRangeWhere(query.from, query.to),
    };

    const [items, total] = await Promise.all([
      this.app.prisma.livePlanEntry.findMany({
        where,
        include: MATCH_LEAGUE_INCLUDE,
        orderBy: { eventStartTime: 'asc' },
        skip:  (query.page - 1) * query.pageSize,
        take:  query.pageSize,
      }),
      this.app.prisma.livePlanEntry.count({ where }),
    ]);

    const names = await this.loadTechnicalNames(items);

    return {
      items:    items.map((row) => this.composeEntry(row, names)),
      total,
      page:     query.page,
      pageSize: query.pageSize,
    };
  }

  // ── Detail ─────────────────────────────────────────────────────────────────
  async getById(id: number): Promise<LivePlanEntryWithLeague> {
    const row = await this.app.prisma.livePlanEntry.findUnique({
      where: { id },
      include: MATCH_LEAGUE_INCLUDE,
    });
    if (!row || row.deletedAt !== null) {
      throw Object.assign(new Error('Live-plan not found'), { statusCode: 404 });
    }
    const names = await this.loadTechnicalNames([row]);
    return this.composeEntry(row, names);
  }

  /**
   * 1 entry + technicalDetails include sonrası, 14 FK alanı için distinct ID
   * setlerini topla; 10 lookup tablosundan tek findMany ile name çek.
   * O(distinct lookup tablo) = 10 query — listede 100 satır için bile sabit.
   */
  private async loadTechnicalNames(rows: EntryWithIncludes[]): Promise<NameMaps> {
    const ids = {
      modulationType: new Set<number>(), videoCoding: new Set<number>(),
      ird: new Set<number>(), fiber: new Set<number>(),
      demod: new Set<number>(), tie: new Set<number>(),
      virtualResource: new Set<number>(), intResource: new Set<number>(),
      offTube: new Set<number>(), language: new Set<number>(),
    };
    const add = (s: Set<number>, v: number | null) => { if (v !== null) s.add(v); };
    for (const r of rows) {
      const t = r.technicalDetails;
      if (!t || t.deletedAt !== null) continue;
      add(ids.modulationType, t.modulationTypeId);
      add(ids.videoCoding,    t.videoCodingId);
      add(ids.ird,            t.ird1Id); add(ids.ird, t.ird2Id); add(ids.ird, t.ird3Id);
      add(ids.fiber,          t.fiber1Id); add(ids.fiber, t.fiber2Id);
      add(ids.demod,          t.demodId);
      add(ids.tie,            t.tieId);
      add(ids.virtualResource,t.virtualResourceId);
      add(ids.intResource,    t.hdvgResourceId); add(ids.intResource, t.int1ResourceId); add(ids.intResource, t.int2ResourceId);
      add(ids.offTube,        t.offTubeId);
      add(ids.language,       t.languageId); add(ids.language, t.secondLanguageId);
    }

    const out = emptyNameMaps();
    const prisma = this.app.prisma;
    const fetchAndFill = async (
      set: Set<number>,
      target: NameMap,
      finder: (ids: number[]) => Promise<Array<{ id: number; label: string }>>,
    ): Promise<void> => {
      if (set.size === 0) return;
      const rows = await finder(Array.from(set));
      for (const r of rows) target.set(r.id, r.label);
    };

    await Promise.all([
      fetchAndFill(ids.modulationType, out.modulationType, (idsIn) =>
        prisma.transmissionModulationType.findMany({ where: { id: { in: idsIn } }, select: { id: true, label: true } })),
      fetchAndFill(ids.videoCoding, out.videoCoding, (idsIn) =>
        prisma.transmissionVideoCoding.findMany({ where: { id: { in: idsIn } }, select: { id: true, label: true } })),
      fetchAndFill(ids.ird, out.ird, (idsIn) =>
        prisma.transmissionIrd.findMany({ where: { id: { in: idsIn } }, select: { id: true, label: true } })),
      fetchAndFill(ids.fiber, out.fiber, (idsIn) =>
        prisma.transmissionFiber.findMany({ where: { id: { in: idsIn } }, select: { id: true, label: true } })),
      fetchAndFill(ids.demod, out.demod, (idsIn) =>
        prisma.transmissionDemodOption.findMany({ where: { id: { in: idsIn } }, select: { id: true, label: true } })),
      fetchAndFill(ids.tie, out.tie, (idsIn) =>
        prisma.transmissionTieOption.findMany({ where: { id: { in: idsIn } }, select: { id: true, label: true } })),
      fetchAndFill(ids.virtualResource, out.virtualResource, (idsIn) =>
        prisma.transmissionVirtualResource.findMany({ where: { id: { in: idsIn } }, select: { id: true, label: true } })),
      fetchAndFill(ids.intResource, out.intResource, (idsIn) =>
        prisma.transmissionIntResource.findMany({ where: { id: { in: idsIn } }, select: { id: true, label: true } })),
      fetchAndFill(ids.offTube, out.offTube, (idsIn) =>
        prisma.livePlanOffTubeOption.findMany({ where: { id: { in: idsIn } }, select: { id: true, label: true } })),
      fetchAndFill(ids.language, out.language, (idsIn) =>
        prisma.livePlanLanguage.findMany({ where: { id: { in: idsIn } }, select: { id: true, label: true } })),
    ]);

    return out;
  }

  private composeEntry(row: EntryWithIncludes, names: NameMaps): LivePlanEntryWithLeague {
    const { match, technicalDetails, ...rest } = row;
    void match;
    return {
      ...(rest as LivePlanEntry),
      ...flattenLeagueOnly(row),
      technicalDetails: buildTechnicalDisplay(technicalDetails, names),
    };
  }

  // ── Create ─────────────────────────────────────────────────────────────────
  async create(dto: CreateLivePlanDto, request: FastifyRequest): Promise<LivePlanEntry> {
    const user = (request.user as { preferred_username?: string })?.preferred_username ?? null;

    // SCHED-B3b (K-B3 lock 2026-05-07): genel manuel create body'sinde
    // eventKey/sourceType KABUL EDİLMEZ; backend forced MANUAL +
    // `manual:<uuid>` üretir. OPTA create yolu sadece POST /from-opta —
    // domain bypass yasak.
    const eventKey   = `manual:${randomUUID()}`;
    const sourceType = 'MANUAL' as const;

    return this.app.prisma.$transaction(async (tx) => {
      // Manuel create için aynı eventKey'li schedule olmaz (yeni UUID), bu
      // yüzden channel slot lookup atılır; ama defensive olarak yine helper
      // kullanılır (gelecekte eventKey backend-set'i değişirse uyumlu kalır).
      const channelSlots = await this.lookupChannelsByEventKey(tx, eventKey);

      const created = await tx.livePlanEntry.create({
        data: {
          title:           dto.title,
          eventStartTime:  new Date(dto.eventStartTime),
          eventEndTime:    new Date(dto.eventEndTime),
          matchId:         dto.matchId,
          optaMatchId:     dto.optaMatchId,
          status:          dto.status,
          operationNotes:  dto.operationNotes,
          // K-B3.20 follow-up: team_1/2_name canonical alanlar (SCHED-B3a
          // schedule create entry'den kopyalar).
          team1Name:       dto.team1Name,
          team2Name:       dto.team2Name,
          // SCHED-B3b backend-forced (K-B3 anti-bypass):
          eventKey,
          sourceType,
          channel1Id:      channelSlots.channel1Id,
          channel2Id:      channelSlots.channel2Id,
          channel3Id:      channelSlots.channel3Id,
          // metadata kolonu M5-B4'te DROP edildi (K15.1).
          createdBy:       user,
        },
      });

      // K12 outbox shadow (routing dışı; poller Phase 2'de pick etmez).
      await writeShadowEvent(tx, {
        eventType:     'live_plan.created',
        aggregateType: SHADOW_AGGREGATE_TYPE,
        aggregateId:   created.id,
        payload:       { livePlanEntryId: created.id },
      });

      return created;
    });
  }

  // ── Update (PATCH) — K9 If-Match zorunlu, version check ────────────────────
  async update(
    id: number,
    dto: UpdateLivePlanDto,
    ifMatchVersion: number,
    _request: FastifyRequest,
  ): Promise<LivePlanEntry> {
    // 1. Existence check (deletedAt defansif; K11 hard-delete sonrası row gone).
    const existing = await this.app.prisma.livePlanEntry.findUnique({ where: { id } });
    if (!existing || existing.deletedAt !== null) {
      throw Object.assign(new Error('Live-plan not found'), { statusCode: 404 });
    }

    // 2. Service-level merge-aware date check (sadece biri gönderildiyse).
    this.validateMergedDates(existing, dto);

    // 3. Tx içi update + outbox shadow.
    return this.app.prisma.$transaction(async (tx) => {
      // Domain karari (2026-05-12): karsilasma bitis saati UI'da yok.
      // eventEndTime kolonu NOT NULL oldugu icin yalniz eventStartTime
      // gonderildiginde backend +2h placeholder ile birlikte yazar
      // (createFromOpta default duration paritesi). Boylece dto bos kalmaz
      // ve merge-check uyumlu kalir.
      const autoEndForStartOnly = (dto.eventStartTime !== undefined && dto.eventEndTime === undefined)
        ? new Date(new Date(dto.eventStartTime).getTime() + 2 * 60 * 60 * 1000)
        : undefined;

      const data: Prisma.LivePlanEntryUpdateInput = {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.eventStartTime !== undefined && { eventStartTime: new Date(dto.eventStartTime) }),
        ...(dto.eventEndTime !== undefined && { eventEndTime: new Date(dto.eventEndTime) }),
        ...(autoEndForStartOnly !== undefined && { eventEndTime: autoEndForStartOnly }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.matchId !== undefined && { matchId: dto.matchId }),
        ...(dto.optaMatchId !== undefined && { optaMatchId: dto.optaMatchId }),
        ...(dto.operationNotes !== undefined && { operationNotes: dto.operationNotes }),
        // K-B3.20 follow-up: team_1/2 update (null → temizle).
        ...(dto.team1Name !== undefined && { team1Name: dto.team1Name }),
        ...(dto.team2Name !== undefined && { team2Name: dto.team2Name }),
        // 3-channel slot canonical (2026-05-11). syncScheduleFromLivePlan
        // channel'a dokunmaz (K-B3.12 schedule kanonik).
        ...(dto.channel1Id !== undefined && { channel1Id: dto.channel1Id }),
        ...(dto.channel2Id !== undefined && { channel2Id: dto.channel2Id }),
        ...(dto.channel3Id !== undefined && { channel3Id: dto.channel3Id }),
        // metadata kolonu M5-B4'te DROP edildi (K15.1).
        version: { increment: 1 },
      };

      const result = await tx.livePlanEntry.updateMany({
        where: { id, version: ifMatchVersion, deletedAt: null },
        data,
      });

      if (result.count !== 1) {
        throw Object.assign(new Error('Live-plan version conflict'), { statusCode: 412 });
      }

      const refreshed = await tx.livePlanEntry.findUniqueOrThrow({ where: { id } });

      // SCHED-B3b (K-B3.21/K-B3.22): live-plan temel bilgi değişimi → aynı
      // eventKey'li schedule kaydına sync (eventKey UNIQUE; tek satır).
      // eventEndTime gitmez (K-B3.23). schedule yoksa sync atılır.
      await this.syncScheduleFromLivePlan(tx, refreshed, dto);

      await writeShadowEvent(tx, {
        eventType:     'live_plan.updated',
        aggregateType: SHADOW_AGGREGATE_TYPE,
        aggregateId:   refreshed.id,
        payload:       { livePlanEntryId: refreshed.id },
      });

      return refreshed;
    });
  }

  // ── Delete (HARD) — K9 If-Match zorunlu, version check ────────────────────
  // Hard-delete cleanup (2026-05-07): operasyonel veri silindiğinde DB'de
  // satır kalmaz. Child tablolar (technical_details + transmission_segments)
  // FK `onDelete: Cascade` ile aynı tx'te silinir. Lookup tablo soft-delete
  // pattern'i (L5/L10) korunur (lifecycle farklı).
  //
  // Sıra: snapshot al → shadow event yaz (silinmiş row'u sonra okuyamayız) →
  // deleteMany version-aware (count==1 zorunlu, 412 on conflict).
  async remove(
    id: number,
    ifMatchVersion: number,
    _request: FastifyRequest,
  ): Promise<LivePlanEntry> {
    const existing = await this.app.prisma.livePlanEntry.findUnique({ where: { id } });
    if (!existing) {
      throw Object.assign(new Error('Live-plan not found'), { statusCode: 404 });
    }

    return this.app.prisma.$transaction(async (tx) => {
      // Shadow event silmeden ÖNCE: payload satır gone olduktan sonra okunamaz.
      // id + eventKey + title minimum identification.
      await writeShadowEvent(tx, {
        eventType:     'live_plan.deleted',
        aggregateType: SHADOW_AGGREGATE_TYPE,
        aggregateId:   existing.id,
        payload: {
          livePlanEntryId: existing.id,
          eventKey:        existing.eventKey,
          title:           existing.title,
        },
      });

      // Optimistic locking: version match olmazsa count==0 → 412.
      // FK Cascade child satırları (technical_details + segments) aynı tx'te
      // siler; manuel updateMany gerekmiyor.
      const result = await tx.livePlanEntry.deleteMany({
        where: { id, version: ifMatchVersion },
      });
      if (result.count !== 1) {
        throw Object.assign(new Error('Live-plan version conflict'), { statusCode: 412 });
      }

      return existing;
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  private buildDateRangeWhere(
    from: string | undefined,
    to:   string | undefined,
  ): Prisma.LivePlanEntryWhereInput {
    if (!from && !to) return {};
    const range: Prisma.DateTimeFilter = {};
    if (from) range.gte = new Date(from);
    if (to)   range.lt  = new Date(to); // half-open (decision §3.3 K7)
    return { eventStartTime: range };
  }

  private validateMergedDates(existing: LivePlanEntry, dto: UpdateLivePlanDto): void {
    // K8 service-level merge-aware: sadece bir tarih gönderildiyse existing ile
    // karşılaştır. İkisi birlikte gönderildiyse Zod refine zaten kapsadı.
    const startProvided = dto.eventStartTime !== undefined;
    const endProvided   = dto.eventEndTime   !== undefined;

    if (startProvided === endProvided) return; // ikisi yoksa veya ikisi varsa skip

    // Domain karari (2026-05-12): yalniz eventStartTime gönderildiyse backend
    // eventEndTime'i +2h placeholder ile birlikte yazar (update() data builder).
    // Bu durumda mergedEnd > mergedStart deterministik olarak korunur; merge
    // check skip — eski existing.eventEndTime'i kullanarak yanlis 400 atmaz.
    if (startProvided && !endProvided) return;

    const mergedStart = startProvided ? new Date(dto.eventStartTime!) : existing.eventStartTime;
    const mergedEnd   = endProvided   ? new Date(dto.eventEndTime!)   : existing.eventEndTime;

    if (mergedEnd <= mergedStart) {
      throw Object.assign(
        new Error('eventEndTime, eventStartTime\'tan sonra olmalı'),
        { statusCode: 400 },
      );
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // SCHED-B3b (K-B3.4-K-B3.12, K-B3.21-K-B3.22, 2026-05-07): live-plan
  // ↔ schedule reverse sync, + duplicate, OPTA-from selection.
  // ───────────────────────────────────────────────────────────────────────

  /**
   * + duplicate (K-B3.4, K-B3.5, K-B3.10, K-B3.11): aynı eventKey için yeni
   * live-plan entry. Kopyalanan: event identity (eventKey/source_type/
   * optaMatchId/matchId), title/team_1/2, eventStart/EndTime, channel slot
   * (event_key match'leyen schedule varsa schedule'dan; yoksa source'tan).
   * Kopyalanmayan: technical_details, transmission_segments, ingest, audit
   * history, version (default 1), createdBy (yeni), operationNotes; status
   * resetlenir → PLANNED.
   */
  async duplicate(id: number, request: FastifyRequest): Promise<LivePlanEntry> {
    const source = await this.app.prisma.livePlanEntry.findUnique({ where: { id } });
    if (!source || source.deletedAt !== null) {
      throw Object.assign(new Error('Live-plan not found'), { statusCode: 404 });
    }

    const user = (request.user as { preferred_username?: string })?.preferred_username ?? null;

    return this.app.prisma.$transaction(async (tx) => {
      // Channel slot (K-B3.12 reverse): event_key match'leyen schedule
      // varsa schedule kanonik; yoksa source'tan kopya.
      const fromSchedule = await this.lookupChannelsByEventKey(tx, source.eventKey);
      const channelSlots = source.eventKey
        ? fromSchedule
        : { channel1Id: source.channel1Id, channel2Id: source.channel2Id, channel3Id: source.channel3Id };

      const created = await tx.livePlanEntry.create({
        data: {
          // Event identity (K-B3.11 kopyalanan):
          eventKey:        source.eventKey,
          sourceType:      source.sourceType,
          optaMatchId:     source.optaMatchId,
          matchId:         source.matchId,
          // Temel bilgi (K-B3.11 kopyalanan):
          title:           source.title,
          team1Name:       source.team1Name,
          team2Name:       source.team2Name,
          eventStartTime:  source.eventStartTime,
          eventEndTime:    source.eventEndTime,
          // Channel slot:
          channel1Id:      channelSlots.channel1Id,
          channel2Id:      channelSlots.channel2Id,
          channel3Id:      channelSlots.channel3Id,
          // Reset / yeni instance:
          status:          'PLANNED', // K-B3.11 status reset
          operationNotes:  null,      // operasyon notu kopyalanmaz
          createdBy:       user,
          // version default 1; technical_details + transmission_segments
          // ayrı tablolar, otomatik kopyalanmaz.
        },
      });

      await writeShadowEvent(tx, {
        eventType:     'live_plan.created',
        aggregateType: SHADOW_AGGREGATE_TYPE,
        aggregateId:   created.id,
        payload:       { livePlanEntryId: created.id, duplicatedFromId: source.id },
      });

      return created;
    });
  }

  /**
   * createFromOpta (K-B3.5, K-B3.10): kullanıcı OPTA seçim akışında
   * matches.opta_uid='<id>' satırından temel bilgi kopya + live_plan_entries
   * yarat (source_type='OPTA', event_key='opta:<id>').
   *
   * - matches satırı yoksa → 404.
   * - match.matchDate NULL → 400 (default tarih üretilmez; user şartı).
   * - Aynı event_key için aktif (deletedAt:null) live-plan entry zaten varsa
   *   → 409 default duplicate engel; çoğaltmak için POST /:id/duplicate.
   * - eventEndTime = matchDate + 2h default planned duration (operatör
   *   sonradan ayarlar).
   */
  async createFromOpta(optaMatchId: string, request: FastifyRequest): Promise<LivePlanEntry> {
    // Pre-tx read-only kontroller (idempotent; race-condition'a takılmaz):
    const match = await this.app.prisma.match.findFirst({
      where: { optaUid: optaMatchId },
    });
    if (!match) {
      throw Object.assign(new Error('OPTA match bulunamadı'), { statusCode: 404 });
    }
    if (!match.matchDate) {
      throw Object.assign(
        new Error('Maç tarihi olmadan Canlı Yayın Plan\'a eklenemez'),
        { statusCode: 400 },
      );
    }

    // DB canonical optaUid kullan (request input'tan değil match satırından).
    // findFirst({ optaUid: optaMatchId }) ile bulundu; non-null garantili.
    const canonicalOptaUid = match.optaUid as string;
    const eventKey         = `opta:${canonicalOptaUid}`;

    const user       = (request.user as { preferred_username?: string })?.preferred_username ?? null;
    const eventStart = match.matchDate;
    // Default planned duration (90 dk maç + 30 dk pre/post = 120 dk = 2h).
    // Operasyon kararı; live-plan eventEndTime canonical.
    const eventEnd   = new Date(eventStart.getTime() + 2 * 3600 * 1000);

    return this.app.prisma.$transaction(async (tx) => {
      // Race-condition guard: live_plan_entries.event_key bilerek non-unique
      // (K-B3.4 + duplicate). Default OPTA import (K-B3.5/K-B3.10) duplicate
      // engellenmeli; iki concurrent request aynı OPTA maçını eklerse
      // findFirst-then-create race iki aktif kayıt yaratabilir. Tx-level
      // advisory lock aynı eventKey'i hash'leyerek seri çalıştırır; ikinci
      // request lock'ı bekler, sonra duplicate check'te 409 alır.
      // pg_advisory_xact_lock SELECT (void; write op DEĞİL); audit
      // extension'a dokunmaz, raw write kuralını bozmaz. Prisma `$queryRaw`
      // void column'u deserialize edemez; tagged `$executeRaw` SELECT'i
      // kabul eder, deserialize etmez, lock acquire edilir. `$executeRawUnsafe`
      // yerine safe parametre interpolation (reviewer kırmızı bayrak yok).
      // Hash collision pratikte düşük risk; ileride iki-int lock standardize
      // edilebilir.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${eventKey}))`;

      // Duplicate check lock alındıktan sonra (tx içinde).
      const existing = await tx.livePlanEntry.findFirst({
        where: { eventKey, deletedAt: null },
      });
      if (existing) {
        throw Object.assign(
          new Error('Bu OPTA maçı zaten Canlı Yayın Plan\'a eklenmiş; çoğaltmak için + duplicate kullanın'),
          { statusCode: 409 },
        );
      }

      const channelSlots = await this.lookupChannelsByEventKey(tx, eventKey);

      const created = await tx.livePlanEntry.create({
        data: {
          title:          `${match.homeTeamName} vs ${match.awayTeamName}`,
          eventStartTime: eventStart,
          eventEndTime:   eventEnd,
          matchId:        match.id,
          optaMatchId:    canonicalOptaUid, // DB canonical
          eventKey,                          // 'opta:<canonicalOptaUid>'
          sourceType:     'OPTA',
          team1Name:      match.homeTeamName,
          team2Name:      match.awayTeamName,
          channel1Id:     channelSlots.channel1Id,
          channel2Id:     channelSlots.channel2Id,
          channel3Id:     channelSlots.channel3Id,
          status:         'PLANNED',
          createdBy:      user,
        },
      });

      await writeShadowEvent(tx, {
        eventType:     'live_plan.created',
        aggregateType: SHADOW_AGGREGATE_TYPE,
        aggregateId:   created.id,
        payload:       { livePlanEntryId: created.id, optaMatchId: canonicalOptaUid },
      });

      return created;
    });
  }

  // ── private SCHED-B3b helpers ──────────────────────────────────────────

  /**
   * SCHED-B3b helper: aynı eventKey için Schedule satırı varsa kanal
   * slotlarını döner; yoksa hepsi NULL.
   */
  private async lookupChannelsByEventKey(
    tx: Prisma.TransactionClient,
    eventKey: string | null,
  ): Promise<{ channel1Id: number | null; channel2Id: number | null; channel3Id: number | null }> {
    if (!eventKey) return { channel1Id: null, channel2Id: null, channel3Id: null };
    const sched = await tx.schedule.findUnique({
      where: { eventKey },
      select: { channel1Id: true, channel2Id: true, channel3Id: true },
    });
    if (!sched) return { channel1Id: null, channel2Id: null, channel3Id: null };
    return {
      channel1Id: sched.channel1Id,
      channel2Id: sched.channel2Id,
      channel3Id: sched.channel3Id,
    };
  }

  /**
   * SCHED-B3b helper: live-plan temel bilgi update sonrası aynı eventKey'li
   * schedule satırına senkron (K-B3.21, K-B3.22). Tek satır hedefli
   * (schedules.eventKey UNIQUE). Schedule yoksa atılır. eventEndTime gitmez
   * (K-B3.23: schedule canonical eventEnd tutmaz).
   */
  private async syncScheduleFromLivePlan(
    tx: Prisma.TransactionClient,
    refreshed: LivePlanEntry,
    dto: UpdateLivePlanDto,
  ): Promise<void> {
    if (!refreshed.eventKey) return;

    const sched = await tx.schedule.findUnique({
      where: { eventKey: refreshed.eventKey },
      select: { id: true },
    });
    if (!sched) return;

    const data: Prisma.ScheduleUpdateInput = {};
    let needSync = false;

    if (dto.title !== undefined) {
      data.title = refreshed.title;
      needSync = true;
    }
    if (dto.team1Name !== undefined) {
      data.team1Name = refreshed.team1Name;
      needSync = true;
    }
    if (dto.team2Name !== undefined) {
      data.team2Name = refreshed.team2Name;
      needSync = true;
    }
    if (dto.eventStartTime !== undefined) {
      const newStart = refreshed.eventStartTime;
      data.scheduleDate = new Date(`${formatDateUtc(newStart)}T00:00:00.000Z`);
      data.scheduleTime = new Date(`1970-01-01T${formatTimeUtc(newStart)}.000Z`);
      // Legacy dual-write (SCHED-B5'e kadar):
      data.startTime = newStart;
      data.endTime   = new Date(newStart.getTime() + 2 * 3600 * 1000); // ⚠ legacy placeholder
      needSync = true;
    }
    // 2026-05-11: Düzenle formundan gelen 3-channel slot değişimi schedule
    // satırına da yansıtılır (kullanıcı beklentisi: iki domain'de aynı kanal).
    // Schedule modelinde channel relation tanımlı değil (scalar-only); direkt
    // FK kolon set'i. dto'da undefined alan schedule satırına dokunmaz.
    // FK validation Prisma `update` ile P2003 üzerinden yakalanır.
    if (dto.channel1Id !== undefined) {
      data.channel1Id = dto.channel1Id;
      needSync = true;
    }
    if (dto.channel2Id !== undefined) {
      data.channel2Id = dto.channel2Id;
      needSync = true;
    }
    if (dto.channel3Id !== undefined) {
      data.channel3Id = dto.channel3Id;
      needSync = true;
    }
    if (!needSync) return;
    data.version = { increment: 1 };

    await tx.schedule.update({ where: { id: sched.id }, data });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// SCHED-B3b helpers (date/time format).
// ───────────────────────────────────────────────────────────────────────────

function formatDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTimeUtc(d: Date): string {
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
