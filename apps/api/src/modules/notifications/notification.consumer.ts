import nodemailer from 'nodemailer';
import type { FastifyInstance } from 'fastify';
import { QUEUES } from '../../plugins/rabbitmq.js';

export interface EmailPayload {
  to: string;
  subject: string;
  body: string;
}

function buildTransport() {
  const host = process.env.SMTP_HOST;
  if (!host) return null;

  return nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT ?? '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}

export async function startNotificationConsumer(app: FastifyInstance): Promise<void> {
  const transport = buildTransport();
  const from = process.env.SMTP_FROM ?? 'noreply@bcms.local';

  await app.rabbitmq.consume<EmailPayload>(QUEUES.NOTIFICATIONS_EMAIL, async (payload) => {
    if (transport) {
      await transport.sendMail({
        from,
        to: payload.to,
        subject: payload.subject,
        text: payload.body,
      });
      app.log.info({ to: payload.to, subject: payload.subject }, 'Email sent');
    } else {
      // SMTP yapılandırılmamışsa sadece logla
      app.log.info(
        { to: payload.to, subject: payload.subject, body: payload.body },
        '[NOTIFICATION] Email simüle edildi (SMTP_HOST tanımlı değil)',
      );
    }
  });

  app.log.info('Notification consumer başlatıldı');
}
