/**
 * MediaHandler — Processes downloaded media attachments into text context.
 *
 * Provides:
 *   classifyAttachment(msg)     → { media_type, media_summary, risk_level }
 *   extractTextFromImage(buf)   → string (OCR via tesseract.js if installed, else stub)
 *   summarizeMedia(meta)        → short string for the decision engine
 *   assessRisk(media_type, src) → 'low' | 'medium' | 'high'
 *
 * Designed to be fully optional — if heavy deps (tesseract, ffprobe) are absent,
 * every function degrades gracefully to metadata-only mode.
 *
 * Environment variables:
 *   OCR_ENABLED=true         — attempt OCR on images (requires: npm i tesseract.js)
 *   MEDIA_DIR=./data/media   — where downloaded files are stored
 *   MEDIA_MAX_OCR_MB=2       — images larger than this (MB) skip OCR
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Feature flags ─────────────────────────────────────────────

const OCR_ENABLED   = process.env.OCR_ENABLED === 'true';
const MAX_OCR_BYTES = (Number(process.env.MEDIA_MAX_OCR_MB) || 2) * 1_024 * 1_024;

// ── Risk classification ───────────────────────────────────────

/**
 * Assess the risk level of an attachment based on its type and source.
 *
 * Risk levels:
 *   low    — sticker, audio (voice note from known contact)
 *   medium — image from known contact, short video
 *   high   — unknown sender + media, executable file, large video from unknown
 *
 * @param {string}  mediaType   — 'image' | 'audio' | 'video' | 'file' | 'sticker' | 'unknown'
 * @param {string}  [source]    — 'known' | 'unknown' | undefined
 * @param {string}  [mimeType]  — e.g. 'application/pdf', 'image/jpeg'
 * @returns {'low'|'medium'|'high'}
 */
function assessRisk(mediaType, source = 'known', mimeType = '') {
  const mime = String(mimeType || '').toLowerCase();

  // Executables / scripts are always high risk
  const dangerousMimes = [
    'application/x-msdownload', 'application/x-executable', 'application/x-sh',
    'application/x-bat', 'application/octet-stream',
  ];
  if (dangerousMimes.some((m) => mime.startsWith(m))) return 'high';

  switch (mediaType) {
    case 'sticker': return 'low';
    case 'audio':   return source === 'unknown' ? 'medium' : 'low';
    case 'image':   return source === 'unknown' ? 'high'   : 'medium';
    case 'video':   return source === 'unknown' ? 'high'   : 'medium';
    case 'file':    return source === 'unknown' ? 'high'   : 'medium';
    case 'unknown': return 'high';
    default:        return 'low';
  }
}

// ── Media summary builder (no download required) ─────────────

/**
 * Build a concise human-readable summary from message metadata.
 * This runs synchronously — no file I/O.
 *
 * @param {{ type, hasMedia, _data, body, from }} msg  — raw whatsapp-web.js Message
 * @returns {string|null}
 */
function buildMetaSummary(msg) {
  if (!msg || !msg.hasMedia) return null;

  const parts = [];
  const data  = msg._data || {};

  const filename = data.filename || data.caption || null;
  const caption  = msg.body || data.caption || null;
  const duration = data.duration ? `${data.duration}s` : null;
  const mime     = data.mimetype || null;
  const size     = data.size ? `${Math.round(data.size / 1024)}KB` : null;

  if (filename) parts.push(`file: "${filename}"`);
  if (caption && caption !== filename) parts.push(`caption: "${caption.slice(0, 80)}"`);
  if (duration) parts.push(`duration: ${duration}`);
  if (size)     parts.push(size);
  if (mime && !filename) parts.push(`(${mime})`);

  return parts.length ? parts.join(' · ') : null;
}

// ── OCR (tesseract.js — graceful no-op if not installed) ──────

/**
 * Attempt OCR on an image buffer.
 * Returns extracted text or null if OCR is disabled / fails.
 *
 * @param {Buffer} imageBuffer
 * @param {string} [lang='eng']
 * @returns {Promise<string|null>}
 */
async function extractTextFromImage(imageBuffer, lang = 'eng') {
  if (!OCR_ENABLED) return null;
  if (!imageBuffer || imageBuffer.length > MAX_OCR_BYTES) return null;

  try {
    // Dynamic require — tesseract.js is optional
    const Tesseract = require('tesseract.js');
    const { data: { text } } = await Tesseract.recognize(imageBuffer, lang, {
      logger: () => {},  // silence progress logs
    });
    const cleaned = (text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    return cleaned.length > 10 ? cleaned : null;
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      // tesseract.js not installed — degrade silently
      return null;
    }
    console.warn('[media-handler] OCR error:', err.message);
    return null;
  }
}

// ── Main classifier ───────────────────────────────────────────

/**
 * Classify an incoming message's media and return enriched metadata.
 *
 * Intended for use in whatsapp-agent / telegram-agent BEFORE posting to /api/ingest.
 *
 * @param {object} msg       — raw platform message object
 * @param {object} [options]
 * @param {boolean} [options.runOcr=false]   — attempt OCR (async, slower)
 * @param {Buffer}  [options.mediaBuffer]    — already-downloaded bytes (optional)
 * @param {string}  [options.fromContext]    — 'known' | 'unknown'
 * @returns {Promise<{ media_type, media_summary, risk_level, ocr_text }>}
 */
async function classifyAttachment(msg, options = {}) {
  // Normalise media_type
  const WA_MAP = {
    image: 'image', video: 'video', audio: 'audio', voice: 'audio',
    ptt: 'audio', sticker: 'sticker', document: 'file', unknown: 'unknown',
  };
  const rawType = msg.type || (msg.hasMedia ? 'unknown' : 'text');
  const media_type = (msg.hasMedia || rawType !== 'chat')
    ? (WA_MAP[rawType] || (msg.hasMedia ? 'unknown' : 'text'))
    : 'text';

  if (media_type === 'text') {
    return { media_type: 'text', media_summary: null, risk_level: 'low', ocr_text: null };
  }

  // Build summary from metadata
  const meta_summary = buildMetaSummary(msg);
  const fromContext  = options.fromContext || 'known';
  const mime         = msg._data?.mimetype || '';
  const risk_level   = assessRisk(media_type, fromContext, mime);

  // OCR pass (images only, if enabled and buffer available)
  let ocr_text = null;
  if (media_type === 'image' && options.runOcr && options.mediaBuffer) {
    ocr_text = await extractTextFromImage(options.mediaBuffer);
  }

  const parts = [];
  if (meta_summary) parts.push(meta_summary);
  if (ocr_text)     parts.push(`text: "${ocr_text.slice(0, 200)}"`);

  const media_summary = parts.join(' | ') || null;

  return { media_type, media_summary, risk_level, ocr_text };
}

// ── Summarize media for the AI prompt ────────────────────────

/**
 * Produce a short string for injection into the AI/decision engine context.
 * Format: "[IMAGE: risk=medium] caption: "photo of dinner""
 *
 * @param {{ media_type, media_summary, risk_level, ocr_text }} meta
 * @returns {string|null}
 */
function summarizeForPrompt(meta) {
  if (!meta || meta.media_type === 'text') return null;

  const typeLabel = String(meta.media_type || 'media').toUpperCase();
  const riskLabel = meta.risk_level ? ` risk=${meta.risk_level}` : '';
  const detail    = meta.media_summary
    ? ` — ${meta.media_summary.slice(0, 120)}`
    : '';
  const ocr       = meta.ocr_text
    ? ` | OCR: "${meta.ocr_text.slice(0, 100)}"`
    : '';

  return `[${typeLabel}${riskLabel}]${detail}${ocr}`;
}

module.exports = {
  assessRisk,
  buildMetaSummary,
  extractTextFromImage,
  classifyAttachment,
  summarizeForPrompt,
};
