/**
 * Avid Cloud UX / CTMS — STP transfer (submitSTPJob).  K3 GERÇEK YOLU.
 *
 * HAR capture (2026-06-01) ile bulundu: Cloud UX "transfer" butonu →
 *   POST https://<CLOUDUX>/apis/avid.pam.stp;version=1;realm=<REALM>/submitSTPJob
 *   Cookie: avidAccessToken=<token>   Body: {"stpRequestDTO":{...}}
 * CDS Service mixdown+encode+SendToPlayback'i KENDİ yapar (IPWS longgopexport
 * "Cannot import" sorunu yok). mobId = HAM sequence (companion gerekmez).
 *
 * ⚠️ MUTATING. VARSAYILAN DRY-RUN (gövdeyi basar, GÖNDERMEZ). --execute ile gerçek.
 *
 *   CLOUDUX_URL=https://172.26.33.57 \
 *   CLOUDUX_REALM=F580021A-2720-4117-B33C-A5B843A2B586 \
 *   CLOUDUX_TOKEN=<avidAccessToken> \
 *   npx tsx apps/api/scripts/avid-ctms-stp-smoke.ts <mobId> <processName> <videoId> \
 *       [--device=MCR] [--profile=MCR] [--execute]
 */
const args = process.argv.slice(2);
const execute = args.includes('--execute');
const rest = args.filter((a) => !a.startsWith('--'));
const argVal = (n: string) => {
  const p = args.find((a) => a.startsWith(`--${n}=`));
  return p ? p.slice(n.length + 3) : undefined;
};

const mobId = rest[0];
const processName = rest[1];
const videoId = rest[2];
const device = argVal('device') || 'MCR';
const profile = argVal('profile') || 'MCR';

const url = (process.env.CLOUDUX_URL || 'https://172.26.33.57').replace(/\/$/, '');
const realm = process.env.CLOUDUX_REALM || 'F580021A-2720-4117-B33C-A5B843A2B586';
const token = process.env.CLOUDUX_TOKEN || '';

function mask(s: string): string {
  if (!s) return '(boş)';
  return s.length <= 6 ? '***' : `${s.slice(0, 4)}…${s.slice(-2)} (${s.length})`;
}

if (!mobId || !processName || !videoId) {
  console.error('Kullanım: avid-ctms-stp-smoke.ts <mobId> <processName> <videoId> [--device=MCR] [--profile=MCR] [--execute]');
  process.exit(2);
}
if (!token) {
  console.error('HATA: CLOUDUX_TOKEN env boş (avidAccessToken cookie değeri gerekli).');
  process.exit(2);
}

const endpoint = `${url}/apis/avid.pam.stp;version=1;realm=${realm}/submitSTPJob`;
const nodeId = `interplay:${realm}:sequence:${mobId}`;
const body = {
  stpRequestDTO: {
    device,
    burnGraphics: false,
    highPriority: false,
    overwrite: false,
    mobId,
    nodeId,
    processName,
    profile,
    videoId,
  },
};
const bodyText = JSON.stringify(body);

console.log('── CTMS submitSTPJob (parola/token maskeli) ──');
console.log('  endpoint :', endpoint);
console.log('  token    :', mask(token));
console.log('  device   :', device, '| profile:', profile);
console.log('  mobId    :', mobId, '(HAM sequence)');
console.log('  nodeId   :', nodeId);
console.log('  process  :', processName);
console.log('  videoId  :', videoId, '(TapeID)');
console.log('  MOD      :', execute ? '⚠️ EXECUTE' : 'DRY-RUN (göndermez)');
console.log();
console.log('── Gönderilecek JSON ──');
console.log(bodyText);
console.log();

if (!execute) {
  console.log('✓ DRY-RUN tamam. Gönderilmedi. --execute ile gerçek submit.');
  process.exit(0);
}

// Self-signed sertifika — sadece bu çağrı için TLS doğrulamasını gevşet.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const res = await fetch(endpoint, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json;charset=UTF-8',
    Accept: 'application/json, text/plain, */*',
    Cookie: `avidAccessToken=${token}`,
    Origin: url,
  },
  body: bodyText,
});
const text = await res.text();
console.log('── ⚠️ EXECUTE sonucu ──');
console.log('  HTTP', res.status, res.statusText);
console.log('  yanıt:', text.slice(0, 1500));
try {
  const j = JSON.parse(text);
  const rd = j.responseData ? JSON.parse(j.responseData) : null;
  if (rd?.jobId) {
    console.log('\n  ✓ jobId      :', rd.jobId);
    console.log('  ✓ statusURL  :', rd.mcdsStatusURL || '(yok)');
  }
  if (j.errorSet?.length || j.errors?.length) {
    console.log('  ✗ errors:', JSON.stringify(j.errorSet || j.errors));
  }
} catch { /* ham yanıt yukarıda */ }
