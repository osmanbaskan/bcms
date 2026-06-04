/**
 * Avid IPWS — K1 (search) canlı smoke. TEK DC, TEK arama. READ-ONLY.
 *
 * Amaç: gerçek IPWS'e `searchByDcCode` çağırıp (a) ham SOAP yanıtını,
 * (b) parse edilmiş AvidAsset[] sonucunu göstermek. `#text` / Duration
 * varsayımlarını canlı veriyle doğrular.
 *
 * Çalıştırma (credentials environment'tan; repoya YAZILMAZ):
 *   AVID_INTERPLAY_URL="http://ipws-host.example.local/services" \
 *   AVID_USER="..." AVID_PASSWORD="..." AVID_WORKSPACE="interplay://BSVMWG/" \
 *   npx tsx apps/api/scripts/avid-search-smoke.ts DC00036170
 *
 * Hiçbir DB/worker/kuyruk dokunmaz; yalnız tek HTTP POST yapar.
 */

import { loadAvidConfig, assertAvidConfigReady } from '../src/modules/avid/avid.config.js';
import { buildSearchBody } from '../src/modules/avid/avid.client.js';
import { postSoap, buildEnvelope, serviceEndpoint, AVID_NS } from '../src/modules/avid/avid.soap.js';
import { getAvidAdapter, __resetAvidAdapterForTest } from '../src/modules/avid/avid.client.js';

function mask(s: string | null): string {
  if (!s) return '(boş)';
  return s.length <= 2 ? '**' : `${s[0]}***${s[s.length - 1]} (${s.length})`;
}

async function main() {
  const dcCode = process.argv[2];
  if (!dcCode) {
    console.error('Kullanım: tsx avid-search-smoke.ts <DC_KODU>   (örn. DC00036170)');
    process.exit(2);
  }

  // Gerçek modu zorla — smoke env'i mock'a düşmesin.
  process.env.RESTORE_AVID_ENABLED = 'on';
  process.env.RESTORE_AVID_MOCK = 'false';

  const cfg = loadAvidConfig();
  console.log('── Config (parola maskeli) ──');
  console.log('  interplayUrl :', cfg.interplayUrl ?? '(boş)');
  console.log('  user         :', cfg.user ?? '(boş)');
  console.log('  password     :', mask(cfg.password));
  console.log('  workspace    :', cfg.workspace ?? '(boş)');
  console.log('  searchRootUri:', cfg.searchRootUri);
  console.log('  endpoint     :', cfg.interplayUrl ? serviceEndpoint(cfg.interplayUrl, 'Assets') : '(boş)');
  console.log('  DC kodu      :', dcCode);
  console.log();

  try {
    assertAvidConfigReady(cfg);
  } catch (err) {
    console.error('✗ Config eksik:', (err as Error).message);
    console.error('  → AVID_INTERPLAY_URL / AVID_USER / AVID_PASSWORD / AVID_WORKSPACE environment\'ta dolu olmalı.');
    process.exit(1);
  }

  // --- 1) HAM SOAP yanıtı (debug: #text / Duration şeklini görmek için) ---
  console.log('── 1) Ham SOAP isteği gönderiliyor (read-only Assets.Search) ──');
  const bodyXml = buildSearchBody(cfg, dcCode);
  // postSoap parse edip Body döndürür; ham metni görmek için fetch'i burada
  // ayrıca düz çağırıyoruz (yalnız debug amaçlı; tek ekstra istek).
  const envelope = buildEnvelope({
    username: cfg.user!,
    password: cfg.password!,
    bodyNs: AVID_NS.assetsTypes,
    bodyXml,
  });
  const endpoint = serviceEndpoint(cfg.interplayUrl!, 'Assets');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
  let rawText = '';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' },
      body: envelope,
      signal: controller.signal,
    });
    rawText = await res.text();
    console.log(`  HTTP ${res.status} ${res.statusText}, ${rawText.length} byte`);
    console.log('  --- ham XML (ilk 2500 karakter) ---');
    console.log(rawText.slice(0, 2500));
    console.log('  --- /ham XML ---\n');
  } catch (err) {
    console.error('✗ Ham istek hatası:', (err as Error).message);
  } finally {
    clearTimeout(timer);
  }

  // --- 2) Gerçek adapter ile parse edilmiş sonuç ---
  console.log('── 2) Adapter.searchByDcCode → AvidAsset[] ──');
  __resetAvidAdapterForTest();
  const adapter = getAvidAdapter();
  try {
    const assets = await adapter.searchByDcCode(dcCode);
    console.log(`  Sonuç: ${assets.length} asset`);
    for (const a of assets) {
      console.log('   •', JSON.stringify(a));
    }
    if (assets.length === 0) {
      console.log('   (0 sonuç — worker bunu NOT_FOUND yapar)');
    }
  } catch (err) {
    console.error('✗ searchByDcCode hatası:', (err as Error).message);
    process.exit(1);
  }

  console.log('\n✓ Smoke tamam.');
}

main().catch((err) => {
  console.error('Beklenmeyen hata:', err);
  process.exit(1);
});
