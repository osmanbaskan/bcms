#!/usr/bin/env node

const baseUrl = process.env.BCMS_API_URL ?? 'http://127.0.0.1:3000/api/v1';
const rootUrl = baseUrl.replace(/\/api\/v1\/?$/, '');

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { response, body, text };
}

async function expectStatus(label, promise, expectedStatus) {
  const result = await promise;
  if (result.response.status !== expectedStatus) {
    throw new Error(`${label}: expected ${expectedStatus}, got ${result.response.status} ${result.text}`);
  }
  console.log(`${label}: ${result.response.status}`);
  return result;
}

async function smokeHealth() {
  const response = await fetch(`${rootUrl}/health`);
  if (!response.ok) throw new Error(`health: expected 2xx, got ${response.status}`);
  console.log(`health: ${response.status}`);
}

async function smokeScheduleOptimisticLock() {
  const now = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + 60 * 60 * 1000);
  let scheduleId;

  try {
    const created = await expectStatus(
      'schedule create',
      request('/schedules', {
        method: 'POST',
        body: JSON.stringify({
          channelId: null,
          startTime: now.toISOString(),
          endTime: end.toISOString(),
          title: 'BCMS schedule lock smoke',
          usageScope: 'broadcast',
          metadata: { source: 'smoke' },
        }),
      }),
      201,
    );
    scheduleId = created.body.id;

    await expectStatus(
      'schedule first patch',
      request(`/schedules/${scheduleId}`, {
        method: 'PATCH',
        headers: { 'if-match': '1' },
        body: JSON.stringify({ title: 'BCMS schedule lock smoke updated' }),
      }),
      200,
    );

    await expectStatus(
      'schedule stale patch',
      request(`/schedules/${scheduleId}`, {
        method: 'PATCH',
        headers: { 'if-match': '1' },
        body: JSON.stringify({ title: 'BCMS schedule lock smoke stale' }),
      }),
      412,
    );
  } finally {
    if (scheduleId) await request(`/schedules/${scheduleId}`, { method: 'DELETE' });
  }
}

async function smokeBookingOptimisticLock() {
  const now = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + 60 * 60 * 1000);
  let scheduleId;
  let bookingId;

  try {
    const schedule = await expectStatus(
      'booking schedule create',
      request('/schedules', {
        method: 'POST',
        body: JSON.stringify({
          channelId: null,
          startTime: now.toISOString(),
          endTime: end.toISOString(),
          title: 'BCMS booking lock smoke',
          usageScope: 'broadcast',
          metadata: { source: 'smoke' },
        }),
      }),
      201,
    );
    scheduleId = schedule.body.id;

    const booking = await expectStatus(
      'booking create',
      request('/bookings', {
        method: 'POST',
        body: JSON.stringify({ scheduleId }),
      }),
      201,
    );
    bookingId = booking.body.id;

    await expectStatus(
      'booking first patch',
      request(`/bookings/${bookingId}`, {
        method: 'PATCH',
        headers: { 'if-match': '1' },
        body: JSON.stringify({ notes: 'first' }),
      }),
      200,
    );

    await expectStatus(
      'booking stale patch',
      request(`/bookings/${bookingId}`, {
        method: 'PATCH',
        headers: { 'if-match': '1' },
        body: JSON.stringify({ notes: 'stale' }),
      }),
      412,
    );
  } finally {
    if (bookingId) await request(`/bookings/${bookingId}`, { method: 'DELETE' });
    if (scheduleId) await request(`/schedules/${scheduleId}`, { method: 'DELETE' });
  }
}

try {
  await smokeHealth();
  await smokeScheduleOptimisticLock();
  await smokeBookingOptimisticLock();
  console.log('api smoke: ok');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
