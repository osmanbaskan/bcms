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

const MAX_EMAIL_RETRIES = 3;

interface EmailPayloadWithMeta extends EmailPayload {
  _retries?: number;
}

export async function startNotificationConsumer(app: FastifyInstance): Promise<void> {
  const transport = buildTransport();
  const from = process.env.SMTP_FROM ?? 'noreply@bcms.local';

  // MED-API-022 fix (2026-05-05): startup'ta transport.verify() ile SMTP
  // erişilebilirliğini doğrula; configuration sorunu varsa runtime'da değil
  // boot'ta görür.
  if (transport) {
    try {
      await transport.verify();
      app.log.info({ host: process.env.SMTP_HOST }, 'SMTP transport doğrulandı');
    } catch (err) {
      app.log.warn({ err, host: process.env.SMTP_HOST }, 'SMTP transport verify başarısız — email simülasyon moduna geçilecek');
    }
  }

  await app.rabbitmq.consume<EmailPayloadWithMeta>(QUEUES.NOTIFICATIONS_EMAIL, async (payload) => {
    if (!transport) {
      app.log.info(
        { to: payload.to, subject: payload.subject, body: payload.body },
        '[NOTIFICATION] Email simüle edildi (SMTP_HOST tanımlı değil)',
      );
      return;
    }

    const attempt = (payload._retries ?? 0) + 1;
    try {
      await transport.sendMail({ from, to: payload.to, subject: payload.subject, text: payload.body });
      app.log.info({ to: payload.to, subject: payload.subject }, 'Email sent');
    } catch (err) {
      if (attempt < MAX_EMAIL_RETRIES) {
        app.log.warn({ to: payload.to, attempt, err }, 'Email gönderilemedi, yeniden denenecek');
        // Retry by re-publishing with incremented counter
        await app.rabbitmq.publish(QUEUES.NOTIFICATIONS_EMAIL, { ...payload, _retries: attempt });
      } else {
        app.log.error({ to: payload.to, subject: payload.subject, attempt, err }, 'Email max deneme aşıldı, mesaj silindi');
      }
    }
  });

  app.log.info('Notification consumer başlatıldı');
}
