const SMB2  = require('@marsaud/smb2');
const fs    = require('fs');
const path  = require('path');

const LOCAL_DIR  = '/mnt/opta-backups/OPTAfromFTP20511';
const REMOTE_DIR = 'OPTAfromFTP20511';
const CONCURRENCY = 5;

const allMissing = JSON.parse(fs.readFileSync('/tmp/opta-missing.json', 'utf8'));
let globalDone = 0, globalErrors = 0;
const total = allMissing.length;

console.log('Toplam indirilecek:', total);

const client = new SMB2({
  share:    process.env.OPTA_SMB_SHARE    ?? '',
  domain:   process.env.OPTA_SMB_DOMAIN   ?? '',
  username: process.env.OPTA_SMB_USERNAME ?? '',
  password: process.env.OPTA_SMB_PASSWORD ?? '',
  autoCloseTimeout: 0,
  packetConcurrency: 8,
});

let idx = 0, active = 0;

function next() {
  if (active === 0 && idx >= allMissing.length) {
    const still = allMissing.filter(f => !fs.existsSync(path.join(LOCAL_DIR, f)));
    console.log('\nBitti:', globalDone, 'indirildi,', globalErrors, 'hata, hâlâ eksik:', still.length);
    fs.writeFileSync('/tmp/opta-missing.json', JSON.stringify(still));
    client.disconnect();
    return;
  }
  while (active < CONCURRENCY && idx < allMissing.length) {
    const file = allMissing[idx++];
    const local = path.join(LOCAL_DIR, file);
    if (fs.existsSync(local)) {
      globalDone++;
      if ((globalDone + globalErrors) % 500 === 0)
        process.stdout.write('\r' + (globalDone+globalErrors) + '/' + total + ' done:' + globalDone + ' err:' + globalErrors);
      continue;
    }
    active++;
    client.readFile(REMOTE_DIR + '/' + file, (err, data) => {
      active--;
      if (err) { globalErrors++; }
      else { try { fs.writeFileSync(local, data); } catch(e){} globalDone++; }
      if ((globalDone + globalErrors) % 500 === 0)
        process.stdout.write('\r' + (globalDone+globalErrors) + '/' + total + ' done:' + globalDone + ' err:' + globalErrors);
      next();
    });
  }
}

next();
