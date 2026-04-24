import Fastify from 'fastify';
import { optaSyncRoutes } from './opta.sync.routes';

describe('Opta Sync Routes', () => {
  let fastify: ReturnType<typeof Fastify>;
  let mockPrisma: any;

  beforeEach(async () => {
    fastify = Fastify();
    
    // Prisma metodlarını mockluyoruz (sahteliyoruz)
    mockPrisma = {
      league: { upsert: jest.fn() },
      match: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() }
    };
    
    // Prisma'yı ve log objesini Fastify instance'ına entegre ediyoruz
    fastify.decorate('prisma', mockPrisma);
    fastify.decorate('log', { info: jest.fn(), error: jest.fn(), warn: jest.fn() });

    await fastify.register(optaSyncRoutes);
  });

  afterEach(() => {
    fastify.close();
    jest.clearAllMocks();
  });

  it('should return 400 if matches array is missing or invalid', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/sync',
      payload: {} // Geçersiz payload gönderiyoruz
    });
    
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload)).toHaveProperty('error');
  });

  it('should insert a new match correctly', async () => {
    // Sahte veritabanı cevaplarını ayarlıyoruz
    mockPrisma.league.upsert.mockResolvedValue({ id: 1, code: 'opta-123' });
    mockPrisma.match.findUnique.mockResolvedValue(null); // DB'de maç yok demek
    mockPrisma.match.create.mockResolvedValue({ id: 100 });

    const payload = {
      matches: [{
        matchUid: 'm-1',
        compId: '123',
        compName: 'Test League',
        homeTeam: 'Team A',
        awayTeam: 'Team B',
        matchDate: '2026-05-01T12:00:00Z',
        season: '2026'
      }]
    };

    const response = await fastify.inject({ method: 'POST', url: '/sync', payload });

    expect(response.statusCode).toBe(200);
    const result = JSON.parse(response.payload);
    expect(result).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    expect(mockPrisma.league.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.match.create).toHaveBeenCalledTimes(1);
  });

  it('should update an existing match if the date has changed', async () => {
    mockPrisma.league.upsert.mockResolvedValue({ id: 1, code: 'opta-123' });
    mockPrisma.match.findUnique.mockResolvedValue({
      id: 100,
      optaUid: 'm-1',
      matchDate: new Date('2026-05-01T10:00:00Z') // Eski tarih (10:00)
    });
    mockPrisma.match.update.mockResolvedValue({ id: 100 });

    const payload = {
      matches: [{
        matchUid: 'm-1',
        compId: '123',
        matchDate: '2026-05-01T12:00:00Z', // Yeni tarih (12:00)
        season: '2026'
      }]
    };

    const response = await fastify.inject({ method: 'POST', url: '/sync', payload });

    expect(response.statusCode).toBe(200);
    const result = JSON.parse(response.payload);
    expect(result).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    expect(mockPrisma.match.update).toHaveBeenCalledTimes(1);
  });
});