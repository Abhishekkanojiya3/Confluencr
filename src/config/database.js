const fs = require('fs');
const path = require('path');

const dataDirectory = path.join(__dirname, '../../data');
const dataFile = path.join(dataDirectory, 'ledger.json');

function ensureDataFile() {
  fs.mkdirSync(dataDirectory, { recursive: true });
  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify({ accounts: [], transactions: [] }, null, 2));
  }
}

function readDatabase() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
}

function writeDatabase(database) {
  ensureDataFile();
  const temporaryFile = `${dataFile}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(database, null, 2));
  fs.renameSync(temporaryFile, dataFile);
}

module.exports = { readDatabase, writeDatabase };
