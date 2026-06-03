/**
 * Avid IPWS — bir asset'in "Video ID" (GUI'de Tape ID) attribute'unu set et.
 * ⚠️ MUTATING (SetAttributes). Yalnız belirtilen attribute'u yazar; Display Name
 * ve diğer alanlar DEĞİŞMEZ. Set sonrası GetAttributes ile doğrular (read-back).
 *
 *   AVID_INTERPLAY_URL=... AVID_USER=... AVID_PASSWORD=... AVID_WORKSPACE=... \
 *   npx tsx apps/api/scripts/avid-set-videoid-smoke.ts <mobid> <deger> [attrName]
 *
 * attrName default "Video ID". Group USER.
 */
import { loadAvidConfig, assertAvidConfigReady } from '../src/modules/avid/avid.config.js';
import { buildEnvelope, AVID_NS, serviceEndpoint, escapeXml } from '../src/modules/avid/avid.soap.js';
import { assetIdToInterplayUri } from '../src/modules/avid/avid.client.js';

async function postAssets(cfg: any, bodyXml: string): Promise<string> {
  const envelope = buildEnvelope({ username: cfg.user, password: cfg.password, bodyNs: AVID_NS.assetsTypes, bodyXml });
  const res = await fetch(serviceEndpoint(cfg.interplayUrl, 'Assets'), {
    method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' }, body: envelope,
  });
  const txt = await res.text();
  return `HTTP ${res.status}\n${txt}`;
}

async function main() {
  const assetId = process.argv[2];
  const value = process.argv[3];
  const attrName = process.argv[4] ?? 'Video ID';
  if (!assetId || !value) { console.error('Kullanım: avid-set-videoid-smoke.ts <mobid> <deger> [attrName]'); process.exit(2); }

  process.env.RESTORE_AVID_ENABLED = 'on';
  process.env.RESTORE_AVID_MOCK = 'false';
  const cfg = loadAvidConfig();
  assertAvidConfigReady(cfg);
  const uri = assetIdToInterplayUri(cfg, assetId);

  console.log('InterplayURI:', uri);
  console.log(`Set: [USER] "${attrName}" = "${value}"\n`);

  // 1) ÖNCE oku (set öncesi durum)
  const beforeBody = `<b:GetAttributes><b:InterplayURIs><b:InterplayURI>${escapeXml(uri)}</b:InterplayURI></b:InterplayURIs></b:GetAttributes>`;
  const before = await postAssets(cfg, beforeBody);
  const beforeVal = before.match(new RegExp(`Name="${attrName}"[^>]*>([^<]*)<`));
  console.log(`── ÖNCE: "${attrName}" =`, beforeVal ? `"${beforeVal[1]}"` : '(YOK/boş)');

  // 2) SetAttributes
  const setBody =
    `<b:SetAttributes>` +
    `<b:InterplayURIs><b:InterplayURI>${escapeXml(uri)}</b:InterplayURI></b:InterplayURIs>` +
    `<b:Attributes><b:Attribute Name="${escapeXml(attrName)}" Group="USER">${escapeXml(value)}</b:Attribute></b:Attributes>` +
    `</b:SetAttributes>`;
  const setResp = await postAssets(cfg, setBody);
  const hasError = /<Error\s+Code=/.test(setResp) || /<Fault/.test(setResp);
  console.log('\n── SetAttributes sonucu:', hasError ? '✗ HATA' : '✓ OK');
  if (hasError) {
    const code = setResp.match(/Code="([^"]+)"/);
    const msg = setResp.match(/<Message>([^<]*)<\/Message>/) || setResp.match(/<faultstring>([^<]*)</);
    console.log('   Code:', code?.[1], '| Msg:', msg?.[1]);
    console.log('   Ham (ilk 600):', setResp.slice(0, 600));
    process.exit(1);
  }

  // 3) SONRA oku (read-back doğrula)
  const after = await postAssets(cfg, beforeBody);
  const afterVal = after.match(new RegExp(`Name="${attrName}"[^>]*>([^<]*)<`));
  console.log(`── SONRA: "${attrName}" =`, afterVal ? `"${afterVal[1]}"` : '(YOK/boş)');
  // Display Name değişmedi mi (güvence)
  const dn = after.match(/Name="Display Name"[^>]*>([^<]*)</);
  console.log('── Display Name (değişmemeli):', dn ? `"${dn[1]}"` : '(?)');

  if (afterVal && afterVal[1] === value) {
    console.log('\n✓ BAŞARILI — Video ID yazıldı, read-back doğrulandı.');
  } else {
    console.log('\n⚠️ Yazıldı ama read-back değeri beklenenle eşleşmedi.');
  }
}
main().catch((e) => { console.error('hata:', (e as Error).message); process.exit(1); });
