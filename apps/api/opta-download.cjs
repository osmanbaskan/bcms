const SMB2  = require('@marsaud/smb2');
const fs    = require('fs');
const path  = require('path');

const LOCAL_DIR  = '/home/ubuntu/opta';
const REMOTE_DIR = 'OPTAfromFTP20511';
const CONCURRENCY = 5;

const allMissing = JSON.parse(fs.readFileSync('/tmp/opta-missing.json', 'utf8'));
let globalDone = 0, globalErrors = 0;
const total = allMissing.length;

console.log('Toplam indirilecek:', total);

const client = new SMB2({
  share: '\\\\172.26.33.248\\BACKUPS',
  domain: 'OPTA_SMB_DOMAIN',
  username: 'OPTA_SMB_USER',
  password: 'OPTA_SMB_PASS',
  autoCloseTimeout: 0,  // manuel kapat
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
