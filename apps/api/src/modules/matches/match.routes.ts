import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PERMISSIONS } from '@bcms/shared';
import { ISTANBUL_TZ } from '../../core/tz.js';

const matchListQuerySchema = z.object({
  leagueId: z.coerce.number().int().positive().optional(),
  from:     z.string().datetime({ offset: true }).optional(),
  to:       z.string().datetime({ offset: true }).optional(),
  season:   z.string().optional(),
  // ORTA-API-1.4.6 fix (2026-05-04): take limit eklendi — boş filter ile
  // tüm fixture döndürmek response bombası. Default 200, üst sınır 1000.
  take:     z.coerce.number().int().min(1).max(1000).optional().default(200),
});

export async function matchRoutes(app: FastifyInstance) {
  // GET /api/v1/matches/leagues — Tüm ligleri döndür
  app.get('/leagues', {
    preHandler: app.requireGroup(...PERMISSIONS.schedules.read),
    schema: {
      tags: ['Matches'],
      summary: 'Mevcut ligleri listele',
    },
  }, async () => {
    return app.prisma.league.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, code: true, name: true, country: true },
    });
  });

  // 2026-05-14: OPTA fixture'ı olmayan ama manuel takım kaydı bulunan
  // ligler — "Yeni Ekle / Manuel Giriş" lig dropdown'ı. Türkiye Basketbol
  // Ligi gibi DB-backed manuel takım listesi olan ligler için.
  // 2026-05-15: Admin tarafından `manual_selectable` toggle eklendi —
  // dropdown filter sıkılaştırıldı: `deleted_at IS NULL`, `manualSelectable
  // = true` ve `teams.count > 0`. OPTA `visible` ile karıştırılmaz.
  app.get('/leagues/manual', {
    preHandler: app.requireGroup(...PERMISSIONS.schedules.read),
    schema: {
      tags: ['Matches'],
      summary: 'Manuel girişte seçilebilir ligler (manualSelectable=true ve teamCount>0)',
    },
  }, async () => {
    const rows = await app.prisma.league.findMany({
      where: { deleted_at: null, manualSelectable: true },
      orderBy: { name: 'asc' },
      select: {
        id: true, code: true, name: true, country: true, sportGroup: true,
        _count: { select: { teams: { where: { deleted_at: null } } } },
      },
    });
    return rows
      .filter((l) => l._count.teams > 0)
      .map(({ _count, ...rest }) => ({ ...rest, teamCount: _count.teams }));
  });

  // 2026-05-15: Admin yönetim listesi — Ayarlar > Manuel Lig Yönetimi
  // ekranı için tüm non-deleted ligler (teamCount=0 dahil; toggle UI'da
  // disabled). Yetki PERMISSIONS.opta.admin paritesi (operatör isteği:
  // "OPTA Lig Görünürlüğü ile birebir aynı").
  app.get('/leagues/manual/admin', {
    preHandler: app.requireGroup(...PERMISSIONS.opta.admin),
    schema: {
      tags: ['Matches'],
      summary: 'Admin: manuel lig seçilebilirlik listesi',
    },
  }, async () => {
    const rows = await app.prisma.league.findMany({
      where:   { deleted_at: null },
      orderBy: [{ sportGroup: 'asc' }, { name: 'asc' }],
      select: {
        id: true, code: true, name: true, country: true, sportGroup: true,
        visible: true, manualSelectable: true,
        _count: { select: { teams: { where: { deleted_at: null } } } },
      },
    });
    return rows.map(({ _count, ...rest }) => ({ ...rest, teamCount: _count.teams }));
  });

  // 2026-05-15: Admin toggle — manualSelectable flag aç/kapat.
  // teamCount=0 olan ligler için yine kabul edilir (operatör bir lig
  // hazırlığı yapıyorsa flag'i önceden açabilir; takım eklendiğinde
  // dropdown'a doğal olarak girer).
  const manualLeagueAdminPatchSchema = z.object({
    manualSelectable: z.boolean(),
  });

  app.patch<{ Params: { id: string } }>('/leagues/manual/admin/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.opta.admin),
    schema: {
      tags: ['Matches'],
      summary: 'Admin: manualSelectable toggle',
    },
  }, async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'invalid league id' });
    }
    const dto = manualLeagueAdminPatchSchema.parse(request.body);
    const data: Prisma.LeagueUpdateInput = { manualSelectable: dto.manualSelectable };
    try {
      const updated = await app.prisma.league.update({
        where: { id },
        data,
        select: {
          id: true, code: true, name: true, country: true, sportGroup: true,
          visible: true, manualSelectable: true,
          _count: { select: { teams: { where: { deleted_at: null } } } },
        },
      });
      const { _count, ...rest } = updated;
      return { ...rest, teamCount: _count.teams };
    } catch (e) {
      if ((e as { code?: string }).code === 'P2025') {
        return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'league not found' });
      }
      throw e;
    }
  });

  // 2026-05-14: Tek ligin takımları — manuel home/away select.
  app.get<{ Params: { id: string } }>('/leagues/:id/teams', {
    preHandler: app.requireGroup(...PERMISSIONS.schedules.read),
    schema: {
      tags: ['Matches'],
      summary: 'Ligin takımlarını listele (deleted_at IS NULL)',
    },
  }, async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'invalid league id' });
    }
    const league = await app.prisma.league.findUnique({
      where:  { id },
      select: { id: true },
    });
    if (!league) {
      return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'league not found' });
    }
    return app.prisma.team.findMany({
      where:   { leagueId: id, deleted_at: null },
      orderBy: { name: 'asc' },
      select:  { id: true, leagueId: true, name: true, shortName: true },
    });
  });

  // GET /api/v1/matches — Fikstür maçlarını listele (leagueId, from, to filtresi)
  app.get('/', {
    preHandler: app.requireGroup(...PERMISSIONS.schedules.read),
    schema: {
      tags: ['Matches'],
      summary: 'Fikstür maçlarını listele',
      querystring: {
        type: 'object',
        properties: {
          leagueId: { type: 'number' },
          from:     { type: 'string', format: 'date-time' },
          to:       { type: 'string', format: 'date-time' },
          season:   { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const q = matchListQuerySchema.parse(request.query);

    const matches = await app.prisma.match.findMany({
      where: {
        ...(q.leagueId ? { leagueId: q.leagueId } : {}),
        ...(q.season   ? { season: q.season }      : {}),
        matchDate: {
          ...(q.from ? { gte: new Date(q.from) } : {}),
          ...(q.to   ? { lte: new Date(q.to)   } : {}),
        },
      },
      include: {
        league: { select: { id: true, code: true, name: true, country: true } },
      },
      orderBy: [{ matchDate: 'asc' }, { id: 'asc' }],
      take: q.take,
    });

    return matches.map((m) => ({
      ...m,
      matchDate: m.matchDate.toISOString(),
      createdAt: m.createdAt.toISOString(),
      label: buildLabel(m.homeTeamName, m.awayTeamName, m.matchDate, m.weekNumber),
    }));
  });
}

// LOW-API-016 fix (2026-05-05): timezone-aware Istanbul format.
const MATCH_TR_MONTHS = ['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];
function buildLabel(home: string, away: string, date: Date, week: number | null): string {
  const parts = new Intl.DateTimeFormat('tr-TR', {
    timeZone: ISTANBUL_TZ, day: '2-digit', month: 'numeric',
    year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const month = parseInt(get('month'), 10);
  const dateStr = `${get('day')} ${MATCH_TR_MONTHS[month - 1]} ${get('year')} ${get('hour')}:${get('minute')}`;
  const weekStr = week ? ` | H${week}` : '';
  return `${home} - ${away} (${dateStr}${weekStr})`;
}
