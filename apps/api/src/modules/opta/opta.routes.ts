import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { buildCompetitionList, loadMatches, clearOptaCache, buildFixtureCompetitions, loadFixtures } from './opta.parser.js';
import { getOptaWatcherStatus } from './opta.watcher.js';
import { readSmbConfig, writeSmbConfig, type SmbConfig } from './opta.smb-config.js';
import { PERMISSIONS } from '@bcms/shared';

export async function optaRoutes(app: FastifyInstance) {

  // GET /api/v1/opta/competitions — DB'deki leagues tablosundan döner
  app.get('/competitions', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.read),
    schema: {
      tags: ['OPTA'],
      summary: 'DB\'deki competition listesi',
    },
  }, async (): Promise<{ id: string; name: string; seasons: string[] }[]> => {
    const rows = await app.prisma.$queryRaw<{ comp_id: string; name: string; season: string }[]>`
      SELECT l.code AS comp_id, l.name, m.season
      FROM leagues l
      JOIN matches m ON m.league_id = l.id
      GROUP BY l.code, l.name, m.season
      ORDER BY l.name, m.season
    `;

    const map = new Map<string, { id: string; name: string; seasons: string[] }>();
    for (const row of rows) {
      const compId = row.comp_id.replace('opta-', '');
      if (!map.has(compId)) map.set(compId, { id: compId, name: row.name, seasons: [] });
      map.get(compId)!.seasons.push(row.season);
    }
    return Array.from(map.values());
  });

  // GET /api/v1/opta/matches?competitionId=X&season=Y[&unscheduled=false]
  app.get<{ Querystring: { competitionId: string; season: string; unscheduled?: string } }>('/matches', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.read),
    schema: {
      tags: ['OPTA'],
      summary: 'Belirli bir competition + season için maç listesi',
      querystring: {
        type: 'object',
        required: ['competitionId', 'season'],
        properties: {
          competitionId: { type: 'string' },
          season:        { type: 'string' },
          unscheduled:   { type: 'string', enum: ['true', 'false'], default: 'true' },
        },
      },
    },
  }, async (request) => {
    const { competitionId, season, unscheduled = 'true' } = request.query;

    const rows = await app.prisma.match.findMany({
      where: {
        league: { code: `opta-${competitionId}` },
        season,
      },
      include: { league: true },
      orderBy: { matchDate: 'asc' },
    });

    let matches = rows.map((m) => ({
      matchId:         m.optaUid ?? String(m.id),
      competitionId,
      competitionName: m.league.name,
      season:          m.season,
      homeTeamName:    m.homeTeamName,
      awayTeamName:    m.awayTeamName,
      matchDate:       m.matchDate.toISOString(),
      venue:           m.venue ?? undefined,
    }));

    if (unscheduled === 'false') return matches;

    const scheduled = await app.prisma.schedule.findMany({
      where: { metadata: { path: ['optaMatchId'], not: Prisma.JsonNull } },
      select: { metadata: true },
    });
    const scheduledIds = new Set(
      scheduled.map((s) => (s.metadata as Record<string, unknown>)?.optaMatchId).filter(Boolean),
    );

    return matches.filter((m) => !scheduledIds.has(m.matchId));
  });

  // GET /api/v1/opta/fixture-competitions — DB'den competition listesi
  app.get('/fixture-competitions', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.read),
    schema: {
      tags: ['OPTA'],
      summary: 'Fikstür verisi olan OPTA competition listesi (DB)',
    },
  }, async (): Promise<{ id: string; name: string; season: string }[]> => {
    const rows = await app.prisma.$queryRaw<{ comp_id: string; name: string; season: string }[]>`
      SELECT l.code AS comp_id, l.name, m.season
      FROM leagues l
      JOIN matches m ON m.league_id = l.id
      GROUP BY l.code, l.name, m.season
      ORDER BY l.name, m.season
    `;
    return rows.map((r) => ({
      id:     r.comp_id.replace('opta-', ''),
      name:   r.name,
      season: r.season,
    }));
  });

  // GET /api/v1/opta/fixtures?competitionId=X&season=Y[&from=ISO]
  app.get<{ Querystring: { competitionId: string; season: string; from?: string } }>('/fixtures', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.read),
    schema: {
      tags: ['OPTA'],
      summary: 'Gelecek fikstürleri DB\'den getir',
      querystring: {
        type: 'object',
        required: ['competitionId', 'season'],
        properties: {
          competitionId: { type: 'string' },
          season:        { type: 'string' },
          from:          { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const { competitionId, season, from } = request.query;
    const afterDate = from ? new Date(from) : undefined;

    const rows = await app.prisma.match.findMany({
      where: {
        league: { code: `opta-${competitionId}` },
        season,
        ...(afterDate ? { matchDate: { gte: afterDate } } : {}),
      },
      include: { league: true },
      orderBy: { matchDate: 'asc' },
    });

    return rows.map((m) => ({
      matchId:         m.optaUid ?? String(m.id),
      competitionId,
      competitionName: m.league.name,
      season:          m.season,
      homeTeamName:    m.homeTeamName,
      awayTeamName:    m.awayTeamName,
      matchDate:       m.matchDate.toISOString(),
      weekNumber:      m.weekNumber,
      label:           `${m.homeTeamName} - ${m.awayTeamName} (${m.matchDate.toLocaleDateString('tr-TR')})`,
    }));
  });

  // POST /api/v1/opta/cache/clear — cache'i zorla yenile
  app.post('/cache/clear', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.write),
    schema: { tags: ['OPTA'], summary: 'OPTA dosya cache\'ini temizle' },
  }, async () => {
    clearOptaCache();
    return { ok: true };
  });

  // GET /api/v1/opta/status — watcher bağlantı durumu
  app.get('/status', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.read),
    schema: { tags: ['OPTA'], summary: 'OPTA watcher bağlantı durumu' },
  }, async () => {
    const status = getOptaWatcherStatus();
    return { ...status, timestamp: new Date().toISOString() };
  });

  // GET /api/v1/opta/smb-config — SMB bağlantı ayarlarını getir (şifre maskelenmiş)
  app.get('/smb-config', {
    preHandler: app.requireRole(...PERMISSIONS.channels.write),
    schema: { tags: ['OPTA'], summary: 'SMB bağlantı ayarlarını getir' },
  }, async () => {
    const cfg = readSmbConfig();
    return { ...cfg, password: cfg.password ? '********' : '' };
  });

  // POST /api/v1/opta/smb-config — SMB bağlantı ayarlarını kaydet
  app.post<{ Body: Partial<SmbConfig> }>('/smb-config', {
    preHandler: app.requireRole(...PERMISSIONS.channels.write),
    schema: {
      tags: ['OPTA'],
      summary: 'SMB bağlantı ayarlarını kaydet ve cred dosyasını güncelle',
      body: {
        type: 'object',
        properties: {
          share:      { type: 'string' },
          mountPoint: { type: 'string' },
          subdir:     { type: 'string' },
          username:   { type: 'string' },
          password:   { type: 'string' },
          domain:     { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const current = readSmbConfig();
    const incoming = request.body;

    // Maskelenmemiş şifre geldiyse kullan; '********' geldiyse eskisini koru
    const password = (incoming.password && incoming.password !== '********')
      ? incoming.password
      : current.password;

    const updated: SmbConfig = {
      share:      incoming.share      ?? current.share,
      mountPoint: incoming.mountPoint ?? current.mountPoint,
      subdir:     incoming.subdir     ?? current.subdir,
      username:   incoming.username   ?? current.username,
      domain:     incoming.domain     ?? current.domain,
      password,
    };

    writeSmbConfig(updated);
    app.log.info({ share: updated.share, username: updated.username }, 'OPTA SMB config güncellendi');
    return { ok: true };
  });
}
