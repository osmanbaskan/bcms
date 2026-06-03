/**
 * Avid IPWS — STP Encode job (com.avid.dms.longgopexport) via SubmitJobUsingProfile.
 * "Use STP Encoding" akışı. Cloud UX (Claudux) `avid.pam.stp:submitSTPJob`
 * bus op'undan canlı yakalanan jobInfo parametreleri (2026-06-01) IPWS
 * longgopexport profil parametrelerine map edilerek Extension içinde gönderilir.
 *
 * ⚠️ MUTATING. VARSAYILAN: DRY-RUN (envelope basar, GÖNDERMEZ). --execute ile gerçek.
 *
 *   AVID_INTERPLAY_URL=... AVID_USER=... AVID_PASSWORD=... AVID_WORKSPACE=... \
 *   npx tsx apps/api/scripts/avid-stpencode-smoke.ts <mobid> <TapeID> \
 *       [--workspace=\\avidnexis\online] [--engine=bsvmte01] [--device=MCR] [--execute]
 *
 * Servis sabit com.avid.dms.longgopexport, profil "new".
 *
 * jobInfo → IPWS longgopexport param eşlemesi (canlı GetProfiles param adları):
 *   tapeId               → TapeID
 *   teHostName           → TM_Server          (TE host, ör. bsvmte01)
 *   teDestination        → TM Profile         (hedef device/DET mapping, ör. MCR)  [BELİRSİZ — teyit gerek]
 *   longGopOutputFileDir → Output Filepath    (workspace\Avid MediaFiles\MXF\temp)
 *   longGopOutputFileName→ Output Filename    (<tapeId>_<uuid>)
 *   audioTargetSampleRate→ Audio Sample Rate  (48000)
 *   audioBitDepth        → Audio Bit Depth    (24)
 *   tmfExport            → TMF_Export          (false)
 *   highPriority         → High Priority       (false)
 *   overwrite            → Overwrite           (false)
 */
import { randomUUID } from 'node:crypto';
import { loadAvidConfig, assertAvidConfigReady } from '../src/modules/avid/avid.config.js';
import { buildEnvelope, AVID_NS, serviceEndpoint, escapeXml } from '../src/modules/avid/avid.soap.js';
import { assetIdToInterplayUri } from '../src/modules/avid/avid.client.js';

function mask(s: string | null): string {
  if (!s) return '(boş)';
  return s.length <= 2 ? '**' : `${s[0]}***${s[s.length - 1]} (${s.length})`;
}

function argVal(args: string[], name: string): string | undefined {
  const p = args.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : undefined;
}

async function postJobs(cfg: any, bodyXml: string, maskPw = false): Promise<string> {
  const envelope = buildEnvelope({
    username: cfg.user, password: maskPw ? '********' : cfg.password,
    bodyNs: AVID_NS.jobsTypes, bodyXml,
  });
  if (maskPw) return envelope; // sadece önizleme
  const res = await fetch(serviceEndpoint(cfg.interplayUrl, 'Jobs'), {
    method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' }, body: envelope,
  });
  return `HTTP ${res.status}\n` + await res.text();
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const rest = args.filter((a) => !a.startsWith('--'));
  const assetId = rest[0];
  const tapeId = rest[1];
  const profile = rest[2] || 'new';
  const service = 'com.avid.dms.longgopexport';
  if (!assetId || !tapeId) {
    console.error('Kullanım: avid-stpencode-smoke.ts <mobid> <TapeID> [profil] [--workspace=..] [--engine=..] [--device=..] [--execute]');
    process.exit(2);
  }

  process.env.RESTORE_AVID_ENABLED = 'on';
  process.env.RESTORE_AVID_MOCK = 'false';
  const cfg = loadAvidConfig();
  assertAvidConfigReady(cfg);
  // longgopexport, `interplay://WG?mobid=` formundan mob'u çıkaramıyor
  // ("Cannot find Mob with id  in any workgroup"). Path-form URI gerekir
  // (ör. interplay://BSVMWG/Projects/RESTORE/DC..._BLM_22.transfer). Arg zaten
  // interplay:// ile başlıyorsa OLDUĞU GİBİ kullan; yoksa mobid'den kur.
  const uri = assetId.startsWith('interplay://') ? assetId : assetIdToInterplayUri(cfg, assetId);

  // Hedef değerleri: arg > env > default. workspace default = online (restore
  // edilen DC medyası editors'ta değil online workspace'inde).
  const workspace = argVal(args, 'workspace') || '\\\\avidnexis\\online';
  const engine = argVal(args, 'engine') || cfg.transferEngine;   // teHostName → TM_Server
  const device = argVal(args, 'device') || cfg.playbackDevice;   // teDestination → TM Profile
  // ÇALIŞAN Cloud UX job (853e companion): Output Filepath =
  // \\avidnexis\editors\Avid MediaFiles\MXF\temp\  (editors + MXF\temp).
  // Output Filename = "12"+TapeID+"_"+uuid+".transfer" formatı.
  const outDir = argVal(args, 'outdir') || `${workspace}\\Avid MediaFiles\\MXF\\temp\\`;
  const outName = argVal(args, 'outname') || `12${tapeId}_${randomUUID()}.transfer`;
  // Başarılı export'ta vardı, bizde yoktu (canlı log farkı):
  const startTc = argVal(args, 'starttc') || '01:00:00:00';
  const duration = argVal(args, 'duration') || '';   // frame sayısı; boşsa gönderme
  // TEK KALAN FARK: çalışan job Source_Server = FQDN bsvmipe.trbeinsports.local,
  // bizim default kısa ad bsvmipe → STP host'unda DNS çözülemeyince AAF gelmiyor
  // → "Cannot import / file not found". FQDN ver. Boş = gönderme (default davranış).
  const sourceServer = argVal(args, 'sourceserver') || '';

  // jobInfo → longgopexport param eşlemesi (SubmitJobUsingParameters/Parameters).
  const params: Record<string, string> = {
    TapeID: tapeId,
    'TM_Server': engine,
    'TM Profile': device,
    'Output Filepath': outDir,
    'Output Filename': outName,
    'Audio Sample Rate': '48000',
    'Audio Bit Depth': '24',
    'Starting Time Code': startTc,
    'TMF_Export': 'false',
    'High Priority': 'false',
    'Overwrite': 'false',
    'DoReEncode': 'true',
  };
  if (duration) params['Duration'] = duration;
  if (sourceServer) params['Source_Server'] = sourceServer;
  const paramXml = Object.entries(params)
    .map(([k, v]) => `<b:Parameter Name="${escapeXml(k)}">${escapeXml(v)}</b:Parameter>`)
    .join('');

  // ⚠️ DOĞRU OP = SubmitJobUsingParameters (Profile DEĞİL).
  // XSD (jobs.xsd SubmitJobUsingParametersType) sırası ZORUNLU:
  //   Service → InterplayURI → Parameters → SourceServerType
  // Parameters Extension'da DEĞİL, gövdenin doğrudan child'ı. SubmitJobUsingProfile
  // Parameters kabul etmiyordu (sadece Profile) — bu yüzden TapeID boş gidiyordu.
  const bodyXml =
    `<b:SubmitJobUsingParameters>` +
    `<b:Service>${escapeXml(service)}</b:Service>` +
    `<b:InterplayURI>${escapeXml(uri)}</b:InterplayURI>` +
    `<b:Parameters>${paramXml}</b:Parameters>` +
    `<b:SourceServerType>Assets</b:SourceServerType>` +
    `</b:SubmitJobUsingParameters>`;

  console.log('── Config (parola maskeli) ──');
  console.log('  endpoint :', serviceEndpoint(cfg.interplayUrl!, 'Jobs'));
  console.log('  user     :', cfg.user, '| pw:', mask(cfg.password));
  console.log('  service  :', service, '(STP Encode / LongGoP)');
  console.log('  profile  :', profile);
  console.log('  asset    :', uri);
  console.log('  ── jobInfo → longgopexport param ──');
  for (const [k, v] of Object.entries(params)) console.log(`     ${k.padEnd(18)}: ${v}`);
  console.log('  workspace:', workspace, '(teDestination=' + device + ', teHostName=' + engine + ')');
  console.log('  MOD      :', execute ? '⚠️ EXECUTE' : 'DRY-RUN (göndermez)');
  console.log();

  console.log('── Gönderilecek envelope (parola maskeli) ──');
  console.log(await postJobs(cfg, bodyXml, true));
  console.log();

  if (!execute) {
    console.log('✓ DRY-RUN tamam. Gönderilmedi. --execute ile gerçek submit.');
    return;
  }

  console.log('── ⚠️ EXECUTE: SubmitJobUsingProfile (STP Encode) ──');
  const resp = await postJobs(cfg, bodyXml);
  const hasErr = /<Error\s+Code=/.test(resp) || /<Fault/.test(resp);
  if (hasErr) {
    const code = (resp.match(/Code="([^"]+)"/) || [])[1];
    const msg = (resp.match(/<(?:\w+:)?Message>([^<]*)</) || [])[1];
    const det = (resp.match(/<(?:\w+:)?Details>([^<]*)</) || [])[1];
    console.log('  ✗ HATA:', code, '|', msg, det ? '| ' + det : '');
    console.log('  ham (ilk 700):', resp.slice(0, 700));
    return;
  }
  const jobUri = (resp.match(/<(?:\w+:)?JobURI>([^<]+)</) || [])[1];
  console.log('  ✓ JobURI:', jobUri || '(yok — ham:)');
  if (!jobUri) { console.log(resp.slice(0, 700)); return; }
}
main().catch((e) => { console.error('hata:', (e as Error).message); process.exit(1); });
