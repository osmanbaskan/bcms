import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BookingService } from './booking.service.js';
import { createBookingSchema, updateBookingSchema } from './booking.schema.js';
import { PERMISSIONS } from '@bcms/shared';

const listBookingsQuerySchema = z.object({
  scheduleId: z.coerce.number().int().positive().optional(),
  page:       z.coerce.number().int().positive().default(1),
  pageSize:   z.coerce.number().int().positive().max(200).default(50),
});

export async function bookingRoutes(app: FastifyInstance) {
  const svc = new BookingService(app);

  app.get('/', {
    preHandler: app.requireGroup(...PERMISSIONS.bookings.read),
    schema: { tags: ['Bookings'] },
  }, async (request) => {
    const q = listBookingsQuerySchema.parse(request.query);
    return svc.findAll(q.scheduleId, q.page, q.pageSize);
  });

  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.bookings.read),
    schema: { tags: ['Bookings'] },
  }, async (request) => svc.findById(Number(request.params.id)));

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
    return svc.update(Number(request.params.id), dto, version, request);
  });

  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.bookings.delete),
    schema: { tags: ['Bookings'], summary: 'Delete booking' },
  }, async (request, reply) => {
    await svc.remove(Number(request.params.id));
    reply.status(204).send();
  });

  // ── Excel toplu import ──────────────────────────────────────────────────────
  app.post('/import', {
    preHandler: app.requireGroup(...PERMISSIONS.bookings.write),
    schema: { tags: ['Bookings'], consumes: ['multipart/form-data'] },
  }, async (request, reply) => {
    const data = await request.file();
    if (!data) throw Object.assign(new Error('Dosya bulunamadı'), { statusCode: 400 });

    const ext = data.filename.split('.').pop()?.toLowerCase();
    if (ext !== 'xlsx') {
      throw Object.assign(new Error('Sadece .xlsx dosyası kabul edilir'), { statusCode: 415 });
    }

    const chunks: Buffer[] = [];
    for await (const chunk of data.file) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const result = await svc.importFromBuffer(buffer, request);
    reply.status(200).send(result);
  });
}
