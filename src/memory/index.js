/**
 * Memory — Lightweight RAG for ReplyWise
 *
 * Retrieves the most relevant past conversation snippets to inject as context
 * into the AI suggestion prompt, so the model can reference things like:
 *   "she mentioned exams last week", "they usually reply with short messages",
 *   "the last time this topic came up they got upset"
 *
 * Two retrieval backends (auto-selected):
 *
 *  1. TF-IDF cosine (default, zero deps)
 *     Fast, works offline, good enough for short chat histories.
 *     MEMORY_BACKEND=tfidf  (or unset)
 *
 *  2. Ollama embeddings (optional upgrade)
 *     Uses nomic-embed-text or any embedding model served by Ollama.
 *     Vectors stored in the JSON store. Better semantic recall.
 *     MEMORY_BACKEND=ollama
 *     MEMORY_EMBED_MODEL=nomic-embed-text
 *
 * Public API:
 *   retrieveContext({ contactId, query, topK })
 *     → { snippets: string[], summary: string, sources: object[] }
 *
 *   indexMessage({ contactId, messageId, body, direction, timestamp })
 *     → void  (async, non-blocking — safe to fire-and-forget)
 *
 *   buildMemoryBlock({ contactId, query, topK })
 *     → string  (ready to inject into a prompt)
 *
 * Environment variables:
 *   MEMORY_ENABLED=true           — master switch (default: true)
 *   MEMORY_BACKEND=tfidf          — 'tfidf' or 'ollama'
 *   MEMORY_TOP_K=4                — snippets to retrieve
 *   MEMORY_MIN_SCORE=0.08         — minimum similarity threshold
 *   MEMORY_MAX_SNIPPET_LEN=120    — chars per snippet
 *   MEMORY_INDEX_WINDOW=200       — last N messages to index per contact
 *   OLLAMA_BASE_URL               — reuses existing Ollama config
 *   MEMORY_EMBED_MODEL=nomic-embed-text
 */

'use strict';

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

// ── Config ────────────────────────────────────────────────────

function cfg(name, def) {
  const v = process.env[name];
  return (v !== undefined && v !== '') ? v : def;
}

const ENABLED          = cfg('MEMORY_ENABLED',        'true') !== 'false';
const BACKEND          = cfg('MEMORY_BACKEND',        'tfidf').toLowerCase();
const TOP_K            = Number(cfg('MEMORY_TOP_K',   '4'));
const MIN_SCORE        = Number(cfg('MEMORY_MIN_SCORE','0.08'));
const MAX_SNIPPET      = Number(cfg('MEMORY_MAX_SNIPPET_LEN', '120'));
const INDEX_WINDOW     = Number(cfg('MEMORY_INDEX_WINDOW',    '200'));
const OLLAMA_URL       = cfg('OLLAMA_BASE_URL',       'http://localhost:11434');
const EMBED_MODEL      = cfg('MEMORY_EMBED_MODEL',    'nomic-embed-text');

// ── Vector store (in-memory + persisted to JSON store) ────────
// Structure: Map<contactId, { messages: [{id, body, direction, ts, vec?}] }>
const _store = new Map();

const STORE_PATH = path.resolve(
  process.env.DATA_DIR || './data',
  'memory-index.json'
);

function loadStoreFromDisk() {
  if (!fs.existsSync(STORE_PATH)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
      _store.set(k, v);
    }
  } catch {
    // corrupt or missing — start fresh
  }
}

function saveStoreToDisk() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const obj = {};
    for (const [k, v] of _store) obj[k] = v;
    fs.writeFileSync(STORE_PATH, JSON.stringify(obj));
  } catch {
    // non-fatal
  }
}

// Lazy load on first use
let _storeLoaded = false;
function ensureLoaded() {
  if (!_storeLoaded) { loadStoreFromDisk(); _storeLoaded = true; }
}

// ── TF-IDF implementation ─────────────────────────────────────

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

const STOPWORDS = new Set([
  'the','and','for','are','but','not','you','all','can','had','her','was',
  'one','our','out','day','get','has','him','his','how','its','may','new',
  'now','old','see','two','way','who','did','let','put','say','she','too',
  'use','hai','nahi','haan','mera','apka','tum','main','kya',
]);

function tf(tokens, term) {
  const count = tokens.filter((t) => t === term).length;
  return tokens.length ? count / tokens.length : 0;
}

function buildTfVector(tokens) {
  const unique = [...new Set(tokens)].filter((t) => !STOPWORDS.has(t));
  const vec = {};
  for (const term of unique) vec[term] = tf(tokens, term);
  return vec;
}

function cosineSimilarity(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0, magA = 0, magB = 0;
  for (const k of keys) {
    const va = a[k] || 0, vb = b[k] || 0;
    dot  += va * vb;
    magA += va * va;
    magB += vb * vb;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

function tfidfSearch(entries, queryVec, topK) {
  return entries
    .map((e) => {
      const tokens = tokenize(e.body);
      const vec    = buildTfVector(tokens);
      return { ...e, score: cosineSimilarity(queryVec, vec) };
    })
    .filter((e) => e.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ── Ollama embedding (optional) ───────────────────────────────

async function ollamaEmbed(text) {
  const res = await axios.post(
    `${OLLAMA_URL}/api/embeddings`,
    { model: EMBED_MODEL, prompt: text },
    { timeout: 15_000 }
  );
  return res.data?.embedding || [];
}

function dotProduct(a, b) {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}

function magnitude(v) {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

function cosineVec(a, b) {
  const m = magnitude(a) * magnitude(b);
  return m > 0 ? dotProduct(a, b) / m : 0;
}

async function ollamaSearch(entries, query, topK) {
  const queryVec = await ollamaEmbed(query);
  const withVecs = await Promise.all(
    entries.map(async (e) => {
      let vec = e.vec;
      if (!vec || !vec.length) {
        try { vec = await ollamaEmbed(e.body); } catch { vec = []; }
      }
      return { ...e, vec, score: cosineVec(queryVec, vec) };
    })
  );
  return withVecs
    .filter((e) => e.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ── Public: indexMessage ──────────────────────────────────────

async function indexMessage({ contactId, messageId, body, direction, timestamp }) {
  if (!ENABLED || !contactId || !body) return;
  ensureLoaded();

  const bucket = _store.get(contactId) || { messages: [] };

  // Deduplicate by messageId
  if (bucket.messages.some((m) => m.id === messageId)) return;

  const entry = {
    id: messageId || `${Date.now()}`,
    body: String(body).slice(0, 400),
    direction: direction || 'incoming',
    ts: timestamp || Date.now(),
    vec: null,
  };

  // Pre-embed for Ollama backend (async, best-effort)
  if (BACKEND === 'ollama') {
    try {
      entry.vec = await ollamaEmbed(entry.body);
    } catch {
      // Ollama unavailable — fall back to TF-IDF at query time
    }
  }

  bucket.messages.push(entry);

  // Trim to INDEX_WINDOW per contact
  if (bucket.messages.length > INDEX_WINDOW) {
    bucket.messages = bucket.messages.slice(-INDEX_WINDOW);
  }

  _store.set(contactId, bucket);

  // Persist asynchronously (debounced via setTimeout)
  if (!indexMessage._saveTimer) {
    indexMessage._saveTimer = setTimeout(() => {
      saveStoreToDisk();
      indexMessage._saveTimer = null;
    }, 3000);
  }
}
indexMessage._saveTimer = null;

// ── Public: retrieveContext ───────────────────────────────────

async function retrieveContext({ contactId, query, topK = TOP_K }) {
  if (!ENABLED || !contactId || !query) {
    return { snippets: [], summary: '', sources: [] };
  }
  ensureLoaded();

  const bucket = _store.get(contactId);
  if (!bucket || !bucket.messages.length) {
    return { snippets: [], summary: '', sources: [] };
  }

  // Exclude very recent messages (already in recentMessages window)
  const cutoff = Date.now() - 3 * 60 * 1000; // older than 3 min
  const candidates = bucket.messages.filter((m) => m.ts < cutoff);
  if (!candidates.length) return { snippets: [], summary: '', sources: [] };

  let results;
  if (BACKEND === 'ollama') {
    try {
      results = await ollamaSearch(candidates, query, topK);
    } catch {
      // Ollama unavailable — fall back to TF-IDF
      const queryVec = buildTfVector(tokenize(query));
      results = tfidfSearch(candidates, queryVec, topK);
    }
  } else {
    const queryVec = buildTfVector(tokenize(query));
    results = tfidfSearch(candidates, queryVec, topK);
  }

  const snippets = results.map((r) => {
    const prefix = r.direction === 'outgoing' ? 'You: ' : 'Them: ';
    return prefix + String(r.body).slice(0, MAX_SNIPPET);
  });

  const summary = snippets.length
    ? `Relevant past context (${snippets.length} snippets):\n${snippets.join('\n')}`
    : '';

  return { snippets, summary, sources: results };
}

// ── Public: buildMemoryBlock ──────────────────────────────────

async function buildMemoryBlock({ contactId, query, topK = TOP_K }) {
  const { snippets } = await retrieveContext({ contactId, query, topK });
  if (!snippets.length) return '';
  return [
    '--- Memory (relevant past messages) ---',
    ...snippets,
    '--- End memory ---',
  ].join('\n');
}

// ── Bulk index for a contact (called after profile refresh) ───

async function bulkIndex(contactId, messages = []) {
  for (const m of messages) {
    await indexMessage({
      contactId,
      messageId: m.id,
      body: m.body,
      direction: m.direction,
      timestamp: new Date(m.timestamp || m.created_at || Date.now()).getTime(),
    });
  }
}

// ── Stats ─────────────────────────────────────────────────────

function stats(contactId) {
  ensureLoaded();
  const b = _store.get(contactId);
  return {
    enabled: ENABLED,
    backend: BACKEND,
    contactId,
    indexed: b ? b.messages.length : 0,
    totalContacts: _store.size,
  };
}

module.exports = {
  indexMessage,
  retrieveContext,
  buildMemoryBlock,
  bulkIndex,
  stats,
};
