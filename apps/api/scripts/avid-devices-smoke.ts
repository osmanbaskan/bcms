/**
 * Avid IPWS — Transfer playback device/engine keşfi. READ-ONLY.
 *
 * SendToPlayback profil-bazlı DEĞİL, cihaz-bazlıdır (rapor §13.1): hedef =
 * (TransferEngineHostName + DestinationPlaybackDevice). Bu script:
 *   1. ListTransferEngines → tüm transfer engine'leri
 *   2. her engine için GetTransferDevices(PLAYBACK) → device isimleri
 * → playback-engine-01/playback-engine-02'de "MCR" gerçekten var mı + tam yazımı doğrulanır.
 *
 * Çalıştırma (credentials env'den; repoya YAZILMAZ):
 *   AVID_INTERPLAY_URL="http://ipws-host.example.local/services" AVID_USER="..." \
 *   AVID_PASSWORD="..." AVID_WORKSPACE="interplay://BSVMWG/" \
 *   npx tsx apps/api/scripts/avid-devices-smoke.ts [engine1 engine2 ...]
 */

import { loadAvidConfig, assertAvidConfigReady } from '../src/modules/avid/avid.config.js';
import { postSoap, AVID_NS } from '../src/modules/avid/avid.soap.js';

function collectStrings(node: unknown, key: string, out: string[]): void {
  if (node == null || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) {
      if (typeof v === 'string') out.push(v);
      else if (Array.isArray(v)) for (const x of v) { if (typeof x === 'string') out.push(x); }
    }
    if (Array.isArray(v)) for (const x of v) collectStrings(x, key, out);
    else if (v && typeof v === 'object') collectStrings(v, key, out);
  }
}

async function main() {
  process.env.RESTORE_AVID_ENABLED = 'on';
  process.env.RESTORE_AVID_MOCK = 'false';
  const cfg = loadAvidConfig();
  assertAvidConfigReady(cfg);

  // 1) ListTransferEngines
  console.log('── ListTransferEngines ──');
  let engines: string[] = process.argv.slice(2);
  try {
    const body = await postSoap(cfg, {
      service: 'Transfer',
      bodyNs: AVID_NS.transferTypes,
      bodyXml: `<b:ListTransferEngines></b:ListTransferEngines>`,
    });
    const found: string[] = [];
    // Yaygın alan adları: HostName / TransferEngineHostName / Name
    for (const key of ['HostName', 'TransferEngineHostName', 'Name', 'Engine']) {
      collectStrings(body, key, found);
    }
    const uniq = [...new Set(found)];
    if (uniq.length) { console.log('  Engine\'ler:', uniq.join(', ')); if (!engines.length) engines = uniq; }
    else console.log('  (engine adı parse edilemedi — ham anahtarlar farklı olabilir)');
  } catch (e) {
    console.log('  ListTransferEngines hata:', (e as Error).message);
  }
  if (!engines.length) engines = ['playback-engine-01', 'playback-engine-02'];

  // 2) Her engine için PLAYBACK device'ları
  for (const engine of engines) {
    console.log(`\n── GetTransferDevices(${engine}, PLAYBACK) ──`);
    try {
      const body = await postSoap(cfg, {
        service: 'Transfer',
        bodyNs: AVID_NS.transferTypes,
        bodyXml:
          `<b:GetTransferDevices>` +
          `<b:TransferEngineHostName>${engine}</b:TransferEngineHostName>` +
          `<b:DeviceType>PLAYBACK</b:DeviceType>` +
          `</b:GetTransferDevices>`,
      });
      const names: string[] = [];
      for (const key of ['Name', 'DeviceName', 'PlaybackDevice']) collectStrings(body, key, names);
      const uniq = [...new Set(names)];
      if (uniq.length) {
        console.log(`  Device'lar (${uniq.length}):`, uniq.join(', '));
        const mcr = uniq.find((d) => d.toLowerCase() === 'mcr');
        if (mcr) console.log(`  ✓ MCR bulundu (tam yazım: "${mcr}")`);
        else console.log('  ⚠️ "MCR" bu engine\'de YOK');
      } else {
        console.log('  (device adı parse edilemedi; ham yanıt aşağıda)');
        console.log('  ', JSON.stringify(body).slice(0, 800));
      }
    } catch (e) {
      console.log(`  hata:`, (e as Error).message);
    }
  }
  console.log('\n✓ Keşif tamam (read-only).');
}

main().catch((e) => { console.error('Beklenmeyen:', e); process.exit(1); });
