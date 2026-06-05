import type { FastifyInstance } from 'fastify';
import { bulletinRoutes } from './news-bulletin.routes.js';
import { storyRoutes } from './news-story.routes.js';
import { mosRoutes } from './news-mos.routes.js';
import { wireRoutes } from './news-wire.routes.js';

/**
 * Haber (NewsWorks NRCS) modülü route aggregatörü — /api/v1/news.
 * EGS NewsWorks 2000 yerine native newsroom. Alt route grupları:
 *  - bülten (rundown) + story (haber)        [Phase 1]
 *  - KJ/SPOT MOS/Vizrt çıkış + cihaz config   [Phase 3]
 *  - ajans (wire)                             [Phase 4]
 */
export async function newsRoutes(app: FastifyInstance) {
  await bulletinRoutes(app);
  await storyRoutes(app);
  await mosRoutes(app);
  await wireRoutes(app);
}
