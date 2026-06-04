/**
 * Avid IPWS — K3 (transfer) smoke. TEK asset. ⚠️ MUTATING + CANLI YAYIN.
 *
 * SendToPlayback asset'i Avid DIŞI yayın havuzuna (PCR/MCR ...) gönderir.
 * Rapor §13: bu op HİÇ çağrılmadı (WSDL-only), hedef (engine+device) OP-TEYİDİ
 * bekliyor. Bu yüzden VARSAYILAN: DRY-RUN — envelope basar, GÖNDERMEZ.
 *
 * Çalıştırma (credentials environment'tan; repoya YAZILMAZ):
 *   # DRY-RUN (güvenli, ağa gönderMEZ):
 *   AVID_INTERPLAY_URL="http://ipws-host.example.local/services" AVID_USER="..." \
 *   AVID_PASSWORD="..." AVID_WORKSPACE="interplay://BSVMWG/" \
 *   npx tsx apps/api/scripts/avid-transfer-smoke.ts <mobid>
 *
 *   # GERÇEK gönderim (⚠️ canlı yayın havuzu — hedef teyidi + AÇIK onay şart):
 *   ... AVID_TRANSFER_ENGINE=... AVID_PLAYBACK_DEVICE=... \
 *   ... npx tsx apps/api/scripts/avid-transfer-smoke.ts <mobid> --execute
 */

import { loadAvidConfig, assertAvidConfigReady } from '../src/modules/avid/avid.config.js';
import {
  assetIdToInterplayUri,
  buildSendToPlaybackBody,
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
    console.error('Kullanım: tsx avid-transfer-smoke.ts <mobid|interplayURI> [--execute]');
    process.exit(2);
  }

  process.env.RESTORE_AVID_ENABLED = 'on';
  process.env.RESTORE_AVID_MOCK = 'false';
  const cfg = loadAvidConfig();

  const interplayUri = assetIdToInterplayUri(cfg, assetId);
  console.log('── Config (parola maskeli) ──');
  console.log('  interplayUrl    :', cfg.interplayUrl ?? '(boş)');
  console.log('  user            :', cfg.user ?? '(boş)');
  console.log('  password        :', mask(cfg.password));
  console.log('  transferEngine  :', cfg.transferEngine, '  (⚠️ hedef OP-TEYİDİ bekliyor)');
  console.log('  playbackDevice  :', cfg.playbackDevice);
  console.log('  transferPriority:', cfg.transferPriority);
  console.log('  asset (mobid)   :', assetId);
  console.log('  InterplayURI    :', interplayUri);
  console.log('  endpoint        :', cfg.interplayUrl ? serviceEndpoint(cfg.interplayUrl, 'Transfer') : '(boş)');
  console.log('  MOD             :', execute ? '⚠️  EXECUTE (CANLI YAYIN HAVUZUNA GÖNDERİR)' : 'DRY-RUN (göndermez)');
  console.log();

  try {
    assertAvidConfigReady(cfg);
  } catch (err) {
    console.error('✗ Config eksik:', (err as Error).message);
    process.exit(1);
  }

  const bodyXml = buildSendToPlaybackBody(cfg, interplayUri);
  const envelopePreview = buildEnvelope({
    username: cfg.user!,
    password: '********',
    bodyNs: AVID_NS.transferTypes,
    bodyXml,
  });
  console.log('── Gönderilecek SOAP envelope (parola maskeli) ──');
  console.log(envelopePreview);
  console.log();

  if (!execute) {
    console.log('✓ DRY-RUN tamam. Hiçbir şey gönderilmedi. Gerçek gönderim için --execute (⚠️ canlı yayın).');
    return;
  }

  // --- GERÇEK GÖNDERİM (⚠️ canlı yayın havuzu) ---
  console.log('── ⚠️ EXECUTE: SendToPlayback gönderiliyor (CANLI) ──');
  __resetAvidAdapterForTest();
  const adapter = getAvidAdapter();
  let avidJobId: string;
  try {
    const r = await adapter.requestTransfer({ assetId, dcCode: 'smoke', channelSlug: 'smoke' });
    avidJobId = r.avidJobId;
    console.log('  ✓ JobURI:', avidJobId);
  } catch (err) {
    console.error('✗ requestTransfer hatası:', (err as Error).message);
    process.exit(1);
  }

  console.log('\n── GetJobStatus izleme (3 × 5sn) ──');
  for (let i = 1; i <= 3; i++) {
    await sleep(5000);
    try {
      const st = await adapter.pollTransferStatus(avidJobId);
      console.log(`  [${i}] status=${st.status}${st.errorMsg ? ' err=' + st.errorMsg : ''}`);
      if (st.status === 'done' || st.status === 'failed') break;
    } catch (err) {
      console.error(`  [${i}] poll hatası:`, (err as Error).message);
    }
  }
  console.log('\n✓ Execute smoke tamam (transfer arka planda sürebilir; worker poll ile takip eder).');
}

main().catch((err) => {
  console.error('Beklenmeyen hata:', err);
  process.exit(1);
});
