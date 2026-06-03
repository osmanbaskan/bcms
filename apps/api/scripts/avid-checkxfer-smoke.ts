/**
 * Avid IPWS — CheckSequenceIsReadyForXfer. READ-ONLY (rapor §10, kılavuz teyitli).
 * Bir sequence'in playback transfer'e hazır olup olmadığını söyler. Hata yoksa
 * READY; hata varsa gerekçe (VIDEO_ID_NOT_FOUND, MEDIA_OFFLINE, OTHER_ERROR...).
 *
 *   AVID_INTERPLAY_URL=... AVID_USER=... AVID_PASSWORD=... AVID_WORKSPACE=... \
 *   npx tsx apps/api/scripts/avid-checkxfer-smoke.ts <mobid|interplayURI>
 */
import { loadAvidConfig, assertAvidConfigReady } from '../src/modules/avid/avid.config.js';
import { buildEnvelope, AVID_NS, serviceEndpoint, escapeXml } from '../src/modules/avid/avid.soap.js';
import { assetIdToInterplayUri } from '../src/modules/avid/avid.client.js';

async function main() {
  const assetId = process.argv[2];
  if (!assetId) { console.error('Kullanım: avid-checkxfer-smoke.ts <mobid|interplayURI>'); process.exit(2); }

  process.env.RESTORE_AVID_ENABLED = 'on';
  process.env.RESTORE_AVID_MOCK = 'false';
  const cfg = loadAvidConfig();
  assertAvidConfigReady(cfg);
  const uri = assetIdToInterplayUri(cfg, assetId);
  console.log('InterplayURI:', uri);

  // body transfer/types ns (b:); credentials assets/types (c:) — postSoap deseni.
  const bodyXml = `<b:CheckSequenceIsReadyForXfer><b:InterplayURI>${escapeXml(uri)}</b:InterplayURI></b:CheckSequenceIsReadyForXfer>`;
  const envelope = buildEnvelope({
    username: cfg.user!, password: cfg.password!,
    bodyNs: AVID_NS.transferTypes, bodyXml,
  });
  const res = await fetch(serviceEndpoint(cfg.interplayUrl!, 'Transfer'), {
    method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' }, body: envelope,
  });
  const txt = await res.text();
  console.log(`HTTP ${res.status}, ${txt.length} byte\n`);

  // <Error Code="..."><Message>..</Message> ler
  const errs = [...txt.matchAll(/<Error\s+Code="([^"]+)"[^>]*>([\s\S]*?)<\/Error>/g)];
  if (errs.length === 0 && !/<Error/.test(txt) && !/<Fault/.test(txt)) {
    console.log('✓ READY — hata yok, sequence transfer\'e hazır.');
  } else if (errs.length) {
    console.log(`✗ NOT READY — ${errs.length} hata:`);
    for (const e of errs) {
      const msg = (e[2].match(/<Message>([^<]*)<\/Message>/) || [])[1] ?? '';
      console.log(`   • ${e[1]}: ${msg}`);
    }
  } else {
    console.log('Ham yanıt (ilk 1200):');
    console.log(txt.slice(0, 1200));
  }
}
main().catch((e) => { console.error('hata:', (e as Error).message); process.exit(1); });
