/**
 * Avid IPWS — GetAttributes ile bir asset'in TÜM attribute'larını çek. READ-ONLY.
 * Search bazen sınırlı alan döndürür; GetAttributes tam liste verir.
 *
 *   AVID_INTERPLAY_URL=... AVID_USER=... AVID_PASSWORD=... AVID_WORKSPACE=... \
 *   npx tsx apps/api/scripts/avid-getattrs-smoke.ts "<mobid|interplayURI>"
 */
import { loadAvidConfig, assertAvidConfigReady } from '../src/modules/avid/avid.config.js';
import { buildEnvelope, AVID_NS, serviceEndpoint, escapeXml } from '../src/modules/avid/avid.soap.js';
import { assetIdToInterplayUri } from '../src/modules/avid/avid.client.js';

async function main() {
  const assetId = process.argv[2];
  if (!assetId) { console.error('Kullanım: avid-getattrs-smoke.ts <mobid|interplayURI>'); process.exit(2); }

  process.env.RESTORE_AVID_ENABLED = 'on';
  process.env.RESTORE_AVID_MOCK = 'false';
  const cfg = loadAvidConfig();
  assertAvidConfigReady(cfg);

  const uri = assetIdToInterplayUri(cfg, assetId);
  console.log('InterplayURI:', uri);

  // GetAttributes — assets ns. InterplayURIs listesi.
  const bodyXml =
    `<a:GetAttributes>` +
    `<a:InterplayURIs><a:InterplayURI>${escapeXml(uri)}</a:InterplayURI></a:InterplayURIs>` +
    `</a:GetAttributes>`;
  // Burada hem body hem credentials assets/types ns'inde → b: = assets/types.
  const envelope = buildEnvelope({
    username: cfg.user!,
    password: cfg.password!,
    bodyNs: AVID_NS.assetsTypes,
    bodyXml: bodyXml.replace(/<a:/g, '<b:').replace(/<\/a:/g, '</b:'),
  });

  const res = await fetch(serviceEndpoint(cfg.interplayUrl!, 'Assets'), {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' },
    body: envelope,
  });
  const txt = await res.text();
  console.log(`HTTP ${res.status}, ${txt.length} byte\n`);

  // Tüm Attribute Name="..." Group="...">değer çiftlerini bas.
  const re = /<Attribute\s+Name="([^"]+)"\s+Group="([^"]+)"\s*>([^<]*)<\/Attribute>/g;
  let m: RegExpExecArray | null;
  let count = 0;
  console.log('── Tüm attribute\'lar ──');
  while ((m = re.exec(txt)) !== null) {
    console.log(`  [${m[2]}] ${m[1]} = ${m[3]}`);
    count++;
  }
  console.log(`\nToplam ${count} attribute.`);
  // Tape/Video geçenleri ayrıca vurgula
  console.log('\n── Tape/Video içeren alanlar ──');
  const re2 = /<Attribute\s+Name="([^"]*(?:[Tt]ape|[Vv]ideo)[^"]*)"\s+Group="([^"]+)"\s*>([^<]*)<\/Attribute>/g;
  let found = false;
  while ((m = re2.exec(txt)) !== null) { console.log(`  ✓ ${m[1]} = ${m[3]}`); found = true; }
  if (!found) console.log('  (Tape/Video içeren attribute YOK)');

  // Ham XML'in ilk kısmı (parse dışı bir şey kaçıyor mu)
  console.log('\n── Ham XML (ilk 1500) ──');
  console.log(txt.slice(0, 1500));
}
main().catch((e) => { console.error('hata:', (e as Error).message); process.exit(1); });
