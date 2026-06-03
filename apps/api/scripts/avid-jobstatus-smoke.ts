/**
 * Avid IPWS — JobURI durum izleme. READ-ONLY (yalnız Jobs.GetJobStatus).
 * Restore (DMS) veya Transfer (XFER) JobURI'sini tamamlanana kadar poll eder.
 *
 *   AVID_INTERPLAY_URL=... AVID_USER=... AVID_PASSWORD=... AVID_WORKSPACE=... \
 *   npx tsx apps/api/scripts/avid-jobstatus-smoke.ts "<JobURI>" [rounds] [gapSec]
 */
import { loadAvidConfig, assertAvidConfigReady } from '../src/modules/avid/avid.config.js';
import { getAvidAdapter, __resetAvidAdapterForTest } from '../src/modules/avid/avid.client.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const jobUri = process.argv[2];
  const rounds = Number(process.argv[3] ?? 10);
  const gapMs = Number(process.argv[4] ?? 20) * 1000;
  if (!jobUri) { console.error('Kullanım: avid-jobstatus-smoke.ts <JobURI> [rounds] [gapSec]'); process.exit(2); }

  process.env.RESTORE_AVID_ENABLED = 'on';
  process.env.RESTORE_AVID_MOCK = 'false';
  const cfg = loadAvidConfig();
  assertAvidConfigReady(cfg);
  __resetAvidAdapterForTest();
  const a = getAvidAdapter();

  console.log('JobURI:', jobUri);
  for (let i = 1; i <= rounds; i++) {
    try {
      const st = await a.pollTransferStatus(jobUri); // = Jobs.GetJobStatus (restore/transfer ortak)
      console.log(`[${i}] ${new Date().toLocaleTimeString('tr-TR')} status=${st.status}${st.errorMsg ? ' err=' + st.errorMsg : ''}`);
      if (st.status === 'done' || st.status === 'failed') { console.log('>>> TERMINAL:', st.status); return; }
    } catch (e) { console.log(`[${i}] poll hata:`, (e as Error).message); }
    if (i < rounds) await sleep(gapMs);
  }
  console.log('(poll turları bitti, hâlâ devam ediyor olabilir)');
}
main().catch((e) => { console.error('Beklenmeyen:', e); process.exit(1); });
