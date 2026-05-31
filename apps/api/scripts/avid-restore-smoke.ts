/**
 * Avid IPWS — K2 (restore) smoke. TEK asset. ⚠️ MUTATING (DIVA→Interplay).
 *
 * VARSAYILAN: DRY-RUN — SubmitJobUsingProfile envelope'unu (parola maskeli)
 * BASAR, HİÇBİR ŞEY GÖNDERMEZ. Gerçek submit için `--execute` ŞART.
 * (PoC `ipws_restore_submit.py --execute` paritesi, rapor §15.7.)
 *
 * Çalıştırma (credentials environment'tan; repoya YAZILMAZ):
 *   # DRY-RUN (güvenli, ağa gönderMEZ):
 *   AVID_INTERPLAY_URL="http://172.26.33.87/services" AVID_USER="..." \
 *   AVID_PASSWORD="..." AVID_WORKSPACE="interplay://BSVMWG/" \
 *   npx tsx apps/api/scripts/avid-restore-smoke.ts <mobid>
 *
 *   # GERÇEK submit (yalnız açık onayla):
 *   ... npx tsx apps/api/scripts/avid-restore-smoke.ts <mobid> --execute
 *
 * Hiçbir DB/worker/kuyruk dokunmaz; --execute yalnız Jobs SOAP çağrıları yapar.
 */

import { loadAvidConfig, assertAvidConfigReady } from '../src/modules/avid/avid.config.js';
import {
  assetIdToInterplayUri,
  buildRestoreSubmitBody,
  getAvidAdapter,
  __resetAvidAdapterForTest,
} from '../src/modules/avid/avid.client.js';
import { buildEnvelope, AVID_NS, serviceEndpoint } from '../src/modules/avid/avid.soap.js';

function mask(s: string | null): string {
  if (!s) return '(boş)';
  return s.length <= 2 ? '**' : `${s[0]}***${s[s.length - 1]} (${s.length})`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const assetId = args.find((a) => !a.startsWith('--'));
  if (!assetId) {
    console.error('Kullanım: tsx avid-restore-smoke.ts <mobid|interplayURI> [--execute]');
    process.exit(2);
  }

  process.env.RESTORE_AVID_ENABLED = 'on';
  process.env.RESTORE_AVID_MOCK = 'false';
  const cfg = loadAvidConfig();

  const interplayUri = assetIdToInterplayUri(cfg, assetId);
  console.log('── Config (parola maskeli) ──');
  console.log('  interplayUrl   :', cfg.interplayUrl ?? '(boş)');
  console.log('  user           :', cfg.user ?? '(boş)');
  console.log('  password       :', mask(cfg.password));
  console.log('  restoreService :', cfg.restoreService);
  console.log('  restoreProfile :', cfg.restoreProfile);
  console.log('  asset (mobid)  :', assetId);
  console.log('  InterplayURI   :', interplayUri);
  console.log('  endpoint       :', cfg.interplayUrl ? serviceEndpoint(cfg.interplayUrl, 'Jobs') : '(boş)');
  console.log('  MOD            :', execute ? '⚠️  EXECUTE (GERÇEK SUBMIT)' : 'DRY-RUN (göndermez)');
  console.log();

  try {
    assertAvidConfigReady(cfg);
  } catch (err) {
    console.error('✗ Config eksik:', (err as Error).message);
    process.exit(1);
  }

  // Gönderilecek envelope'u her durumda göster (parola maskeli).
  const bodyXml = buildRestoreSubmitBody(cfg, interplayUri);
  const envelopePreview = buildEnvelope({
    username: cfg.user!,
    password: '********', // önizlemede parola maskeli
    bodyNs: AVID_NS.jobsTypes,
    bodyXml,
  });
  console.log('── Gönderilecek SOAP envelope (parola maskeli) ──');
  console.log(envelopePreview);
  console.log();

  if (!execute) {
    console.log('✓ DRY-RUN tamam. Hiçbir şey gönderilmedi. Gerçek submit için --execute ekle.');
    return;
  }

  // --- GERÇEK SUBMIT ---
  console.log('── ⚠️ EXECUTE: SubmitJobUsingProfile gönderiliyor ──');
  __resetAvidAdapterForTest();
  const adapter = getAvidAdapter();
  let avidJobId: string;
  try {
    const r = await adapter.requestRestore({ assetId, dcCode: 'smoke', channelSlug: 'smoke' });
    avidJobId = r.avidJobId;
    console.log('  ✓ JobURI:', avidJobId);
  } catch (err) {
    console.error('✗ requestRestore hatası:', (err as Error).message);
    process.exit(1);
  }

  console.log('\n── GetJobStatus izleme (3 × 5sn) ──');
  for (let i = 1; i <= 3; i++) {
    await sleep(5000);
    try {
      const st = await adapter.pollRestoreStatus(avidJobId);
      console.log(`  [${i}] status=${st.status}${st.errorMsg ? ' err=' + st.errorMsg : ''}`);
      if (st.status === 'done' || st.status === 'failed') break;
    } catch (err) {
      console.error(`  [${i}] poll hatası:`, (err as Error).message);
    }
  }
  console.log('\n✓ Execute smoke tamam (restore arka planda sürebilir; worker poll ile takip eder).');
}

main().catch((err) => {
  console.error('Beklenmeyen hata:', err);
  process.exit(1);
});
