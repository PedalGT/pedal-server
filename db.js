// Minimal JSON-file store. Good enough for a hackathon demo, no native installs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// DATA_DIR puts the data somewhere that survives redeploys (on Azure App Service,
// /home is permanent storage). The first time, it starts from the bundled data.json.
const BUNDLED = path.join(__dirname, 'data.json');
const FILE = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'data.json') : BUNDLED;
if (FILE !== BUNDLED && !fs.existsSync(FILE)) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  if (fs.existsSync(BUNDLED)) fs.copyFileSync(BUNDLED, FILE);
}

const empty = () => ({
  users: [],
  sessions: [],   // { token, userId, createdAt }
  bikes: [],
  rides: [],
  txns: [],       // wallet ledger: balance = sum of amountCents
  commands: [],   // pending lock commands: { bikeId, action, createdAt }
  cardLinks: []   // pending "link my card" requests: { userId, expiresAt }
});

let data = empty();
if (fs.existsSync(FILE)) {
  try { data = { ...empty(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; }
  catch { console.warn('data.json unreadable, starting fresh'); }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  }, 50);
}

const id = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

// Short, readable bike codes (no 0/O/1/I confusion)
function bikeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), b => chars[b % chars.length]).join('');
  } while (data.bikes.some(b => b.code === code));
  return code;
}

function balanceOf(userId) {
  return data.txns.filter(t => t.userId === userId).reduce((s, t) => s + t.amountCents, 0);
}

module.exports = { data, save, id, bikeCode, balanceOf };
