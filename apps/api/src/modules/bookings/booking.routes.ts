import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BookingService } from './booking.service.js';
import {
  createBookingSchema,
  updateBookingSchema,
  createBookingCommentSchema,
  listBookingsQuerySchema,
} from './booking.schema.js';
import { PERMISSIONS, type BcmsGroup, type JwtPayload } from '@bcms/shared';

export async function bookingRoutes(app: FastifyInstance) {
  const svc = new BookingService(app);

  app.get('/', {
    preHandler: app.requireGroup(...PERMISSIONS.bookings.read),
    schema: { tags: ['Bookings'] },
  }, async (request) => {
    const q = listBookingsQuerySchema.parse(request.query);
    return svc.findAll(request, q.scheduleId, q.group, q.page, q.pageSize, q.qTitle, q.status);
  });

  app.get('/assignees', {
    preHandler: app.requireGroup(...PERMISSIONS.bookings.read),
    schema: { tags: ['Bookings'], summary: 'Grup üyeleri' },
  }, async (request) => {
    const q = z.object({ group: z.string().min(1).max(50) }).parse(request.query);
    return svc.findAssignableUsers(request, q.group as BcmsGroup);
  });

  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.bookings.read),
    schema: { tags: ['Bookings'] },
  }, async (request) => svc.findByIdForRequest(z.coerce.number().int().positive().parse(request.params.id), request.user as JwtPayload));

  app.post('/', {
    preHandler: app.requireGroup(...PERMISSIONS.bookings.write),
    schema: { tags: ['Bookings'] },
  }, async (request, reply) => {
    const dto = createBookingSchema.parse(request.body);
    reply.status(201).send(await svc.create(dto, request));
  });

  app.patch<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.bookings.write),
    schema: { tags: ['Bookings'] },
  }, async (request) => {
    const dto = updateBookingSchema.parse(request.body);
    const version = request.headers['if-match'] ? parseInt(request.headers['if-match'] as string, 10) : undefined;
    return svc.update(z.coerce.number().int().positive().parse(request.params.id), dto, version, request);
  });

  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.bookings.delete),
    schema: { tags: ['Bookings'], summary: 'Delete booking' },
  }, async (request, reply) => {
    await svc.removeForRequest(z.coerce.number().int().positive().parse(request.params.id), request);
    reply.status(204).send();
  });

  // ── 2026-05-14: İş Takip yorum + durum geçmişi ─────────────────────────────
  //
  // Yetki: PERMISSIONS.bookings.read (auth-only); fine-grained `canSee`
  // service.assertBookingVisible üzerinden — booking yok 404, görünmüyor 403.
  // Admin universal; SystemEng özel değil.

  const idParam = z.coerce.number().int().positive();

  app.get<{ Params: { id: string } }>('/:id/comments', {
    preHandler: app.requireGroup(...PERMISSIONS.bookings.read),
    schema: { tags: ['Bookings'], summary: 'Comment listesi (createdAt asc)' },
  }, async (request) => svc.listComments(idParam.parse(request.params.id), request));

  app.post<{ Params: { id: string } }>('/:id/comments', {
    preHandler: app.requireGroup(...PERMISSIONS.bookings.read),
    schema: { tags: ['Bookings'], summary: 'Comment ekle (plain text)' },
  }, async (request, reply) => {
    const dto = createBookingCommentSchema.parse(request.body);
    const created = await svc.addComment(idParam.parse(request.params.id), dto, request);
    reply.status(201).send(created);
  });

  app.get<{ Params: { id: string } }>('/:id/status-history', {
    preHandler: app.requireGroup(...PERMISSIONS.bookings.read),
    schema: { tags: ['Bookings'], summary: 'Durum geçmişi (kronolojik)' },
  }, async (request) => svc.listStatusHistory(idParam.parse(request.params.id), request));

}
