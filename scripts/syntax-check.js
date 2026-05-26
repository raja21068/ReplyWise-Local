const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
}
walk(path.join(root, 'src'));
walk(path.join(root, 'scripts'));

let failed = false;
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  if (res.status !== 0) {
    failed = true;
    console.error(`✗ ${path.relative(root, file)}\n${res.stderr.toString()}`);
  } else {
    console.log(`✓ ${path.relative(root, file)}`);
  }
}
process.exit(failed ? 1 : 0);
