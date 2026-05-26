require('dotenv').config();
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const STORE_FILE = path.resolve(process.env.STORE_FILE || path.join(DATA_DIR, 'conversationos.store.json'));

if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
console.log(`Reset store: ${STORE_FILE}`);
