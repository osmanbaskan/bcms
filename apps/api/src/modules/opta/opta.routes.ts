import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { buildCompetitionList, loadMatches, clearOptaCache, buildFixtureCompetitions, loadFixtures } from './opta.parser.js';
import { getOptaWatcherStatus } from './opta.watcher.js';
import { readSmbConfig, writeSmbConfig, type SmbConfig } from './opta.smb-config.js';
import { PERMISSIONS } from '@bcms/shared';

export async function optaRoutes(app: FastifyInstance) {

  // GET /api/v1/opta/competitions
  app.get('/competitions', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.read),
    schema: {
      tags: ['OPTA'],
      summary: 'SMB arşivindeki competition listesi',
    },
  }, async () => {
    return buildCompetitionList();
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
    const matches = loadMatches(competitionId, season);
    if (unscheduled === 'false') return matches;

    // Zaten yayın planına eklenmiş optaMatchId'leri çek
    const scheduled = await app.prisma.schedule.findMany({
      where: { metadata: { path: ['optaMatchId'], not: Prisma.JsonNull } },
      select: { metadata: true },
    });
    const scheduledIds = new Set(
      scheduled.map((s) => (s.metadata as Record<string, unknown>)?.optaMatchId).filter(Boolean),
    );

    return matches.filter((m) => !scheduledIds.has(m.matchId));
  });

  // GET /api/v1/opta/fixture-competitions — srml results dosyalarından competition listesi
  app.get('/fixture-competitions', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.read),
    schema: {
      tags: ['OPTA'],
      summary: 'Fikstür verisi olan OPTA competition listesi (srml)',
    },
  }, async () => {
    return buildFixtureCompetitions();
  });

  // GET /api/v1/opta/fixtures?competitionId=X&season=Y[&from=ISO]
  app.get<{ Querystring: { competitionId: string; season: string; from?: string } }>('/fixtures', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.read),
    schema: {
      tags: ['OPTA'],
      summary: 'Gelecek fikstürleri srml dosyasından getir',
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
    return loadFixtures(competitionId, season, afterDate);
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
