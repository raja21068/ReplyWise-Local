/**
 * WhatsApp Agent v3 — whatsapp-web.js with media handling + per-chat autopilot.
 *
 * New in v3 (merged from LLM-for-Whatsapp)
 * ────────────────────────────────────────
 * • Detects message media type (image / audio / video / file / sticker)
 * • Downloads media when WHATSAPP_DOWNLOAD_MEDIA=true (default: false to save disk)
 * • Populates media_type + media_summary on the ingest payload so the Decision Engine
 *   can make smarter routing choices without needing the actual bytes.
 * • Sticker-only messages are ingested as media_type=sticker (not silently dropped).
 * • Error path for failed sends now marks the outgoing item as 'failed' in the DB.
 *
 * Merged from LLM-for-Whatsapp
 * ─────────────────────────────
 * • Per-chat auto_reply_enabled toggle — contacts can be individually opted in/out
 * • Reply delay modes: instant | normal | random (respects REPLY_DELAY_MODE env or per-contact rule)
 * • isForwarded and isStarred flags passed through to ingest metadata
 * • Proper session destroy + auth directory cleanup on logout (logoutAndCleanup())
 * • Group message support: passes author field for group chats
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

// ── Reply delay (merged from LLM-for-Whatsapp) ───────────────

const REPLY_DELAY_DEFAULTS = {
  instant: 0,
  normal:  1500,   // ~1.5 s — feels human
  random:  null,   // computed at runtime
};

function computeReplyDelayMs(contactRules = {}) {
  const mode = contactRules.reply_delay_mode
    || process.env.REPLY_DELAY_MODE
    || 'normal';

  if (mode === 'instant') return 0;

  if (mode === 'random') {
    const min = Number(process.env.REPLY_DELAY_RANDOM_MIN_MS || 1000);
    const max = Number(process.env.REPLY_DELAY_RANDOM_MAX_MS || 6000);
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // 'normal' or per-contact fixed
  const fixed = Number(contactRules.reply_delay_seconds || 0) * 1000;
  return fixed > 0 ? fixed : REPLY_DELAY_DEFAULTS.normal;
}

// ── Media type mapping from whatsapp-web.js message types ────
const WA_TYPE_MAP = {
  image:    'image',
  video:    'video',
  audio:    'audio',
  voice:    'audio',
  ptt:      'audio',
  sticker:  'sticker',
  document: 'file',
  unknown:  'unknown',
};

function resolveMediaType(msg) {
  if (!msg.hasMedia && msg.type === 'chat') return 'text';
  return WA_TYPE_MAP[msg.type] || (msg.hasMedia ? 'unknown' : 'text');
}

async function buildMediaSummary(msg) {
  // Returns a short human-readable hint without downloading the file.
  if (!msg.hasMedia) return null;

  const type = resolveMediaType(msg);
  const filename = msg._data?.filename || msg._data?.caption || null;
  const caption   = msg.body || msg._data?.caption || null;
  const duration  = msg._data?.duration ? `${msg._data.duration}s` : null;
  const mimeType  = msg._data?.mimetype || null;

  const parts = [];
  if (filename)  parts.push(filename);
  if (caption)   parts.push(`"${caption.slice(0, 60)}"`);
  if (duration)  parts.push(`duration: ${duration}`);
  if (mimeType && !filename) parts.push(mimeType);

  return parts.length ? parts.join(' · ') : null;
}

class WhatsAppAgent extends EventEmitter {
  constructor() {
    super();
    this.channel = 'whatsapp';
    this.name = 'WhatsApp';
    this.running = false;
    this.healthy = false;
    this.lastError = null;
    this.client = null;
    this.qrData = null;

    this.orchestratorUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
    this.sessionDir = path.resolve(process.env.SESSION_DIR || './data/sessions', 'whatsapp');
    this.outgoingPollMs = Number(process.env.BRIDGE_POLL_MS) || 3000;
    this.actionDelayMin = Number(process.env.ACTION_DELAY_MIN) || 500;
    this.actionDelayMax = Number(process.env.ACTION_DELAY_MAX) || 2000;
    this.downloadMedia = process.env.WHATSAPP_DOWNLOAD_MEDIA === 'true';
    this.mediaDir = path.resolve(process.env.MEDIA_DIR || './data/media', 'whatsapp');

    fs.mkdirSync(this.sessionDir, { recursive: true });
    if (this.downloadMedia) fs.mkdirSync(this.mediaDir, { recursive: true });
  }

  async start() {
    this.log('Starting WhatsApp agent...');
    this.running = true;

    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: this.sessionDir }),
      puppeteer: {
        headless: process.env.BROWSER_HEADLESS !== 'false',
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-setuid-sandbox',
        ],
      },
    });

    // ── QR code for first-time login ──────────────────────────
    this.client.on('qr', (qr) => {
      this.qrData = qr;
      this.log('QR code received — scan with your phone');
      qrcode.generate(qr, { small: true });
      this.reportStatus('login_required');
      this.emit('qr', qr);
    });

    // ── Authenticated ─────────────────────────────────────────
    this.client.on('authenticated', () => {
      this.log('Authenticated successfully');
      this.qrData = null;
    });

    // ── Ready ─────────────────────────────────────────────────
    this.client.on('ready', () => {
      this.log('Client is ready — listening for messages');
      this.healthy = true;
      this.reportStatus('active');
      this.startOutgoingLoop();
    });

    // ── Incoming messages (text + media) ──────────────────────
    this.client.on('message', async (msg) => {
      if (msg.fromMe) return;
      if (msg.isStatus) return;

      try {
        const contact = await msg.getContact();
        const displayName = contact.pushname || contact.name || msg.from;
        const mediaType   = resolveMediaType(msg);
        const mediaSummary = await buildMediaSummary(msg);

        // Determine body: for media-only messages (sticker, image without caption) use empty string
        const body = String(msg.body || '').trim();

        this.log(`← [${displayName}] [${mediaType}]: ${(body || `<${mediaType}>`).slice(0, 80)}`);

        // Optionally download media to disk
        let localMediaPath = null;
        if (this.downloadMedia && msg.hasMedia) {
          try {
            const media = await msg.downloadMedia();
            if (media && media.data) {
              const ext = media.mimetype?.split('/')?.[1]?.split(';')?.[0] || 'bin';
              const fname = `${msg.id?.id || Date.now()}.${ext}`;
              localMediaPath = path.join(this.mediaDir, fname);
              fs.writeFileSync(localMediaPath, Buffer.from(media.data, 'base64'));
            }
          } catch (e) {
            this.log(`Media download failed: ${e.message}`);
          }
        }

        const chat = await msg.getChat().catch(() => null);
        const myJid = this.client?.info?.wid?._serialized || this.client?.info?.wid?.user || null;
        const mentionedIds = Array.isArray(msg.mentionedIds) ? msg.mentionedIds : [];
        const mentionedMe = Boolean(myJid && mentionedIds.some(id => String(id).includes(String(myJid).replace('@c.us', ''))));
        let quotedFromMe = false;
        if (msg.hasQuotedMsg) {
          try {
            const quoted = await msg.getQuotedMessage();
            quotedFromMe = Boolean(quoted?.fromMe);
          } catch { /* ignore */ }
        }

        await axios.post(`${this.orchestratorUrl}/api/ingest/whatsapp`, {
          from: msg.from,
          externalContactId: msg.from,
          displayName,
          body: body || `[${mediaType}]`,
          timestamp: msg.timestamp ? msg.timestamp * 1000 : Date.now(),
          media_type: mediaType,
          media_summary: mediaSummary,
          local_media_path: localMediaPath,
          has_media: msg.hasMedia,
          // Merged from LLM-for-Whatsapp
          is_forwarded: msg.isForwarded || false,
          is_starred: msg.isStarred || false,
          author: msg.author || null,       // group chats: who sent it
          is_group: chat?.isGroup || false,
          mentioned_me: mentionedMe,
          reply_to_me: quotedFromMe,
        }, { timeout: 15000 });

      } catch (err) {
        this.log(`Error processing incoming: ${err.message}`);
      }
    });

    // ── Disconnected ──────────────────────────────────────────
    this.client.on('disconnected', (reason) => {
      this.log(`Disconnected: ${reason}`);
      this.healthy = false;
      this.reportStatus('disconnected', reason);
      this.emit('disconnected', reason);
    });

    this.client.on('auth_failure', (msg) => {
      this.log(`Auth failure: ${msg}`);
      this.healthy = false;
      this.lastError = msg;
      this.reportStatus('error', msg);
    });

    await this.client.initialize();
  }

  // ── Per-chat autopilot toggle (merged from LLM-for-Whatsapp) ─

  /**
   * Called by the orchestrator API when the user flips the toggle on a contact.
   * Stores the preference in the DB via REST; the agent re-reads it on next ingest.
   */
  async setAutoReplyForContact(externalContactId, enabled) {
    try {
      await axios.post(`${this.orchestratorUrl}/api/contacts/by-external/${encodeURIComponent(externalContactId)}/auto-reply`,
        { enabled, channel: 'whatsapp' },
        { timeout: 5000 }
      );
      this.log(`Auto-reply ${enabled ? 'enabled' : 'disabled'} for ${externalContactId}`);
    } catch (err) {
      this.log(`setAutoReplyForContact failed: ${err.message}`);
    }
  }

  // ── Proper session cleanup (merged from LLM-for-Whatsapp) ──

  /**
   * Destroys the whatsapp-web.js client AND removes the local auth directory,
   * forcing a fresh QR scan on next start. Useful for account switching.
   */
  async logoutAndCleanup() {
    this.log('Logging out and clearing session...');
    this.running = false;
    if (this.client) {
      try { await this.client.destroy(); } catch { /* already destroyed */ }
      this.client = null;
    }
    // Remove auth data so next start requires a fresh QR scan
    const authPath = path.resolve(this.sessionDir, 'session-default');
    try {
      if (require('fs').existsSync(authPath)) {
        require('fs').rmSync(authPath, { recursive: true, force: true });
        this.log(`Auth directory removed: ${authPath}`);
      }
    } catch (e) {
      this.log(`Could not remove auth dir: ${e.message}`);
    }
    await this.reportStatus('logged_out');
    this.log('Logout complete');
  }

  async stop() {
    this.log('Stopping...');
    this.running = false;
    if (this.client) {
      try { await this.client.destroy(); } catch { /* already destroyed */ }
    }
    this.reportStatus('stopped');
  }

  // ── Send message via whatsapp-web.js API ──────────────────

  async sendMessageViaUI(page, { externalContactId, body }) {
    if (!this.client) throw new Error('Client not initialized');
    await this.randomDelay(this.actionDelayMin, this.actionDelayMax);
    await this.client.sendMessage(externalContactId, body);
  }

  // ── Outgoing queue polling ────────────────────────────────

  startOutgoingLoop() {
    const poll = async () => {
      if (!this.running) return;
      try {
        const res = await axios.get(`${this.orchestratorUrl}/api/bridge/pending-outgoing`, {
          params: { channel: 'whatsapp', limit: 5 },
          timeout: 10000,
        });
        const items = res.data?.outgoing || [];
        for (const item of items) {
          try {
            await this.sendMessageViaUI(null, {
              externalContactId: item.external_contact_id || item.externalContactId,
              body: item.body,
            });
            await axios.post(
              `${this.orchestratorUrl}/api/bridge/outgoing/${item.id}/sent`,
              {},
              { timeout: 10000 }
            );
            this.log(`→ Sent to ${item.display_name || item.external_contact_id}`);
          } catch (err) {
            this.log(`Send failed ${item.id}: ${err.message}`);
            try {
              await axios.post(
                `${this.orchestratorUrl}/api/bridge/outgoing/${item.id}/failed`,
                { error: err.message },
                { timeout: 5000 }
              );
            } catch { /* ignore */ }
          }
        }
      } catch (err) {
        if (err.code !== 'ECONNREFUSED') this.log(`Outgoing poll error: ${err.message}`);
      }
      if (this.running) setTimeout(poll, this.outgoingPollMs);
    };
    setTimeout(poll, 2000);
  }

  // ── Utility ───────────────────────────────────────────────

  async reportStatus(status, errorLog = null) {
    try {
      await axios.post(`${this.orchestratorUrl}/api/agents/${this.channel}/status`, {
        status, errorLog,
      }, { timeout: 5000 });
    } catch { /* orchestrator might not be up */ }
  }

  randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async randomDelay(min, max) {
    return new Promise((r) => setTimeout(r, this.randomInt(min, max)));
  }

  getQrData() { return this.qrData; }

  async isLoggedIn() {
    try {
      const state = await this.client?.getState();
      return state === 'CONNECTED';
    } catch {
      return false;
    }
  }

  log(msg) {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] [WhatsApp] ${msg}`);
  }
}

// ── Standalone launch ─────────────────────────────────────────
if (require.main === module) {
  require('dotenv').config();
  const agent = new WhatsAppAgent();
  agent.start().catch((err) => {
    console.error('WhatsApp agent failed:', err);
    process.exit(1);
  });
  process.on('SIGINT', () => agent.stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => agent.stop().then(() => process.exit(0)));
}

module.exports = WhatsAppAgent;
