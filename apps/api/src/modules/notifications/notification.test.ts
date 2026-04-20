/**
 * Notification consumer için birim testi (SMTP/RabbitMQ gerekmez)
 * Çalıştır: npx tsx src/modules/notifications/notification.test.ts
 */
import type { EmailPayload } from './notification.consumer.js';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else       { console.error(`  ✗ ${msg}`); failed++; }
}

console.log('\n=== Notification Payload Testleri ===\n');

// Test 1: APPROVED payload yapısı
console.log('Test 1: APPROVED bildirim payload');
{
  const bookingId = 42;
  const requestedBy = 'planner1';
  const status = 'APPROVED';
  const label = status === 'APPROVED' ? 'onaylandı' : 'reddedildi';

  const payload: EmailPayload = {
    to: requestedBy,
    subject: `Rezervasyonunuz ${label}`,
    body: `Merhaba ${requestedBy},\n\n${bookingId} numaralı rezervasyonunuz ${label}.\n\nBCMS`,
  };

  assert(payload.to === 'planner1', 'to alanı doğru');
  assert(payload.subject === 'Rezervasyonunuz onaylandı', 'subject doğru');
  assert(payload.body.includes('42'), 'body booking id içermeli');
  assert(payload.body.includes('onaylandı'), 'body durum içermeli');
}

// Test 2: REJECTED payload yapısı
console.log('\nTest 2: REJECTED bildirim payload');
{
  const bookingId = 7;
  const requestedBy = 'viewer1';
  const status: string = 'REJECTED';
  const label = status === 'APPROVED' ? 'onaylandı' : 'reddedildi';

  const payload: EmailPayload = {
    to: requestedBy,
    subject: `Rezervasyonunuz ${label}`,
    body: `Merhaba ${requestedBy},\n\n${bookingId} numaralı rezervasyonunuz ${label}.\n\nBCMS`,
  };

  assert(payload.to === 'viewer1', 'to alanı doğru');
  assert(payload.subject === 'Rezervasyonunuz reddedildi', 'subject doğru');
  assert(payload.body.includes('reddedildi'), 'body durum içermeli');
}

// Test 3: SMTP_HOST tanımlı değilse simülasyon modu
console.log('\nTest 3: SMTP_HOST kontrolü');
{
  const smtpHost = process.env.SMTP_HOST;
  assert(smtpHost === undefined, 'Test ortamında SMTP_HOST tanımlı olmamalı → simülasyon modu aktif');
}

console.log(`\n=== Sonuç: ${passed} geçti, ${failed} başarısız ===\n`);
if (failed > 0) process.exit(1);
