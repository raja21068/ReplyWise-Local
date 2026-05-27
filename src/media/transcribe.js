/**
 * Local voice-note transcription helper.
 *
 * Free-cost defaults:
 * - Disabled unless TRANSCRIBE_ENABLED=true.
 * - No cloud calls.
 * - Tries a local whisper.cpp / Whisper CLI command when configured/installed.
 * - Caches transcripts by file hash so the same audio is not processed twice.
 *
 * Supported backends:
 * - TRANSCRIBE_BACKEND=auto        Try whisper.cpp/whisper commands.
 * - TRANSCRIBE_BACKEND=whisper_cpp Use WHISPER_CPP_BIN + WHISPER_MODEL.
 * - TRANSCRIBE_BACKEND=python_whisper Use `whisper` CLI.
 * - TRANSCRIBE_BACKEND=command     Use TRANSCRIBE_COMMAND with {file} placeholder.
 * - TRANSCRIBE_BACKEND=http        POST file to WHISPER_HTTP_URL (local service).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const CACHE_FILE = path.resolve(process.env.TRANSCRIBE_CACHE_FILE || path.join(DATA_DIR, 'transcripts.json'));

function boolEnv(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  const tmp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, CACHE_FILE);
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

async function transcribe(filePath) {
  if (!boolEnv('TRANSCRIBE_ENABLED', false)) {
    return { text: '', backend: 'disabled', cached: false, skipped: true };
  }
  if (!filePath || !fs.existsSync(filePath)) {
    return { text: '', backend: 'missing_file', cached: false, skipped: true };
  }

  const hash = sha256File(filePath);
  const cache = readCache();
  if (cache[hash]?.text) {
    return { ...cache[hash], cached: true };
  }

  const backend = String(process.env.TRANSCRIBE_BACKEND || 'auto').toLowerCase();
  let result;
  if (backend === 'http') result = await transcribeHttp(filePath);
  else if (backend === 'command') result = await transcribeCommand(filePath);
  else if (backend === 'python_whisper') result = await transcribePythonWhisper(filePath);
  else if (backend === 'whisper_cpp') result = await transcribeWhisperCpp(filePath);
  else result = await transcribeAuto(filePath);

  const normalized = {
    text: String(result?.text || '').trim(),
    backend: result?.backend || backend || 'auto',
    cached: false,
    created_at: new Date().toISOString(),
  };
  if (normalized.text) {
    cache[hash] = normalized;
    writeCache(cache);
  }
  return normalized;
}

async function transcribeAuto(filePath) {
  const candidates = [];
  if (process.env.WHISPER_CPP_BIN && process.env.WHISPER_MODEL) candidates.push(() => transcribeWhisperCpp(filePath));
  candidates.push(() => transcribePythonWhisper(filePath));
  candidates.push(() => transcribeWhisperCpp(filePath));
  for (const fn of candidates) {
    try {
      const r = await fn();
      if (r?.text) return r;
    } catch {
      // Try the next local backend.
    }
  }
  return { text: '', backend: 'auto_no_backend' };
}

async function transcribeWhisperCpp(filePath) {
  const bin = process.env.WHISPER_CPP_BIN || findExecutable(['whisper-cli', 'main', 'whisper.cpp']);
  const model = process.env.WHISPER_MODEL;
  if (!bin || !model) return { text: '', backend: 'whisper_cpp_not_configured' };

  const outBase = path.join(DATA_DIR, 'transcribe', `${path.basename(filePath)}-${Date.now()}`);
  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  const args = ['-m', model, '-f', filePath, '-otxt', '-of', outBase];
  await run(bin, args, Number(process.env.TRANSCRIBE_TIMEOUT_MS || 120000));
  const txt = `${outBase}.txt`;
  return { text: fs.existsSync(txt) ? fs.readFileSync(txt, 'utf8').trim() : '', backend: 'whisper_cpp' };
}

async function transcribePythonWhisper(filePath) {
  const bin = process.env.PYTHON_WHISPER_BIN || findExecutable(['whisper']);
  if (!bin) return { text: '', backend: 'python_whisper_not_installed' };
  const outDir = path.join(DATA_DIR, 'transcribe', `whisper-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const model = process.env.PYTHON_WHISPER_MODEL || 'base';
  const args = [filePath, '--model', model, '--output_format', 'txt', '--output_dir', outDir];
  await run(bin, args, Number(process.env.TRANSCRIBE_TIMEOUT_MS || 180000));
  const txtFiles = fs.readdirSync(outDir).filter(f => f.endsWith('.txt'));
  const txt = txtFiles[0] ? path.join(outDir, txtFiles[0]) : null;
  return { text: txt ? fs.readFileSync(txt, 'utf8').trim() : '', backend: 'python_whisper' };
}

async function transcribeCommand(filePath) {
  const cmd = process.env.TRANSCRIBE_COMMAND;
  if (!cmd) return { text: '', backend: 'command_not_configured' };
  const parts = splitCommand(cmd.replace('{file}', filePath));
  const { stdout } = await run(parts[0], parts.slice(1), Number(process.env.TRANSCRIBE_TIMEOUT_MS || 120000));
  return { text: stdout.trim(), backend: 'command' };
}

async function transcribeHttp(filePath) {
  const url = process.env.WHISPER_HTTP_URL;
  if (!url || typeof fetch !== 'function') return { text: '', backend: 'http_not_configured' };
  const data = new FormData();
  const blob = new Blob([fs.readFileSync(filePath)]);
  data.append('file', blob, path.basename(filePath));
  const res = await fetch(url, { method: 'POST', body: data });
  if (!res.ok) throw new Error(`Whisper HTTP failed: ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const json = await res.json();
    return { text: json.text || json.transcript || '', backend: 'http' };
  }
  return { text: await res.text(), backend: 'http' };
}

function findExecutable(names) {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const name of names) {
    for (const dir of dirs) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Transcription timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => { clearTimeout(t); reject(err); });
    child.on('close', code => {
      clearTimeout(t);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

function splitCommand(command) {
  const parts = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(command))) parts.push(m[1] || m[2] || m[3]);
  return parts;
}

module.exports = { transcribe };
