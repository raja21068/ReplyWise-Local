'use strict';

/**
 * WhatsApp Agent — class-based, compatible with AgentManager
 * ────────────────────────────────────────────────────────────
 * • Extends EventEmitter (emits 'qr', 'disconnected', 'login_required')
 * • Exposes start(), stop(), healthy, getQrData()
 * • 60s timeout on server POST + 3 automatic retries
 * • Auto-polls outgoing queue and sends approved messages
 *
 * Improvements over v1:
 *   ✓ Media download + classifyAttachment() → real risk scores & OCR
 *   ✓ message_ack  → delivery/read receipts posted to server
 *   ✓ message_revoked_me → deleted-message notifications
 *   ✓ reaction     → emoji reaction events
 *   ✓ mentioned_me → correctly resolved from msg.mentionedIds
 *   ✓ location     → lat/lng extracted from Location messages
 *   ✓ vCards       → contact-card bodies forwarded as text
 *   ✓ links        → first URL extracted and attached
 *   ✓ isGif        → gifs classified separately from video
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode       = require('qrcode-terminal');
const axios        = require('axios');
const path         = require('path');
const fs           = require('fs');
const EventEmitter = require('events');

const { classifyAttachment, summarizeForPrompt } = require('../media/media-handler');

// ─── Media type map ────────────────────────────────────────────
const WA_TYPE_MAP = {
  chat:     'text',
  image:    'image',
  video:    'video',
  gif:      'gif',
  audio:    'audio',
  voice:    'audio',
  ptt:      'audio',
  sticker:  'sticker',
  document: 'file',
  location: 'location',
  vcard:    'vcard',
  multi_vcard: 'vcard',
};


function formatDecisionForLog(decision) {
  if (!decision) return '?';
  if (typeof decision === 'string') return decision;
  const action = decision.action || decision.should_reply || decision.kind || 'unknown';
  const confidence = decision.confidence != null ? ` ${decision.confidence}%` : '';
  const risk = decision.risk || decision.risk_level || decision.temperature || '';
  const reason = decision.reason ? ` — ${String(decision.reason).slice(0, 90)}` : '';
  return `${action}${confidence}${risk ? ` risk:${risk}` : ''}${reason}`;
}

function resolveMediaType(msg) {
  if (msg.isGif) return 'gif';
  if (!msg.hasMedia && msg.type === 'chat') return 'text';
  return WA_TYPE_MAP[msg.type] || (msg.hasMedia ? 'unknown' : 'text');
}

// ─── Helper: POST with retries ─────────────────────────────────
async function postWithRetry(url, data, { timeout = 60_000, retries = 3 } = {}) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await axios.post(url, data, { timeout });
      return res.data;
    } catch (err) {
      lastErr = err;
      if (i < retries) await new Promise(r => setTimeout(r, 2000 * i));
    }
  }
  throw lastErr;
}

// ─── Agent class ───────────────────────────────────────────────
class WhatsAppAgent extends EventEmitter {
  constructor() {
    super();
    this.channel    = 'whatsapp';
    this.name       = 'WhatsApp';
    this.healthy    = false;
    this.running    = false;
    this.client     = null;
    this.qrData     = null;
    this.lastError  = null;

    this.orchestratorUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
    this.sessionDir      = path.resolve(process.env.SESSION_DIR || './data/sessions', 'whatsapp');
    this.pollMs          = Number(process.env.BRIDGE_POLL_MS) || 3000;

    // Map whatsapp msgId → internal outgoing message id, for ack tracking
    this._pendingAcks = new Map();

    fs.mkdirSync(this.sessionDir, { recursive: true });
  }

  // ── Public: start ────────────────────────────────────────────
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
          '--disable-setuid-sandbox',
          '--disable-gpu',
        ],
      },
    });

    // ── Auth events ──────────────────────────────────────────
    this.client.on('qr', (qr) => {
      this.qrData = qr;
      this.log('Scan this QR code with WhatsApp → Linked Devices → Link a Device:');
      qrcode.generate(qr, { small: true });
      this.reportStatus('login_required');
      this.emit('qr', qr);
      this.emit('login_required');
    });

    this.client.on('authenticated', () => {
      this.log('✓ Authenticated');
      this.qrData = null;
    });

    this.client.on('auth_failure', (msg) => {
      this.log(`✗ Auth failed: ${msg}`);
      this.healthy   = false;
      this.lastError = msg;
      this.reportStatus('error', msg);
    });

    // ── Ready — start outgoing loop ──────────────────────────
    this.client.on('ready', () => {
      const name = this.client?.info?.pushname || this.client?.info?.wid?.user || 'unknown';
      this.log(`✓ Ready — logged in as ${name}`);
      this.healthy = true;
      this.reportStatus('active');
      this._startOutgoingLoop();
    });

    // ── Incoming messages ────────────────────────────────────
    this.client.on('message', async (msg) => {
      if (msg.fromMe || msg.isStatus) return;
      await this._handleIncoming(msg);
    });

    // ── Delivery / read receipts ─────────────────────────────
    // ack values: 0=pending, 1=sent, 2=received (device), 3=read, 4=played
    this.client.on('message_ack', async (msg, ack) => {
      if (!msg.fromMe) return;
      const internalId = this._pendingAcks.get(msg.id._serialized);
      if (!internalId) return;

      const ackLabel = ['pending', 'sent', 'delivered', 'read', 'played'][ack] || String(ack);
      this.log(`✓ ACK ${ackLabel} — msg ${msg.id._serialized}`);

      try {
        await axios.post(
          `${this.orchestratorUrl}/api/bridge/outgoing/${internalId}/ack`,
          { ack, ack_label: ackLabel, wa_msg_id: msg.id._serialized },
          { timeout: 5000 }
        );
      } catch { /* non-critical */ }

      // Clean up once fully read/played
      if (ack >= 3) this._pendingAcks.delete(msg.id._serialized);
    });

    // ── Revoked / deleted messages ───────────────────────────
    this.client.on('message_revoke_me', async (msg) => {
      this.log(`↩ Message revoked by ${msg.from}: ${msg.id._serialized}`);
      try {
        await axios.post(
          `${this.orchestratorUrl}/api/ingest/whatsapp/revoked`,
          {
            wa_msg_id: msg.id._serialized,
            from:      msg.from,
            timestamp: Date.now(),
          },
          { timeout: 10_000 }
        );
      } catch (err) {
        this.log(`✗ Revoke notify failed: ${err.message}`);
      }
    });

    // ── Emoji reactions ──────────────────────────────────────
    this.client.on('message_reaction', async (reaction) => {
      // reaction: { id, senderId, reaction (emoji string), msgId, read, orphan }
      if (!reaction.reaction) return; // empty = reaction removed
      this.log(`💬 Reaction "${reaction.reaction}" on ${reaction.msgId._serialized} from ${reaction.senderId}`);
      try {
        await axios.post(
          `${this.orchestratorUrl}/api/ingest/whatsapp/reaction`,
          {
            wa_msg_id:  reaction.msgId._serialized,
            from:       reaction.senderId,
            emoji:      reaction.reaction,
            timestamp:  Date.now(),
          },
          { timeout: 10_000 }
        );
      } catch (err) {
        this.log(`✗ Reaction notify failed: ${err.message}`);
      }
    });

    // ── Disconnected ─────────────────────────────────────────
    this.client.on('disconnected', (reason) => {
      this.log(`Disconnected: ${reason}`);
      this.healthy = false;
      this.reportStatus('disconnected', reason);
      this.emit('disconnected', reason);
    });

    await this.client.initialize();
  }

  // ── Public: stop ─────────────────────────────────────────────
  async stop() {
    this.log('Stopping...');
    this.running = false;
    this.healthy = false;
    if (this.client) {
      try { await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
    }
    this.reportStatus('stopped');
  }

  // ── Public: logout + clear session ───────────────────────────
  async logoutAndCleanup() {
    this.log('Logging out and clearing session...');
    await this.stop();
    const authPath = path.resolve(this.sessionDir, 'session-default');
    try {
      if (fs.existsSync(authPath)) {
        fs.rmSync(authPath, { recursive: true, force: true });
        this.log(`Session cleared: ${authPath}`);
      }
    } catch (e) {
      this.log(`Could not clear session: ${e.message}`);
    }
    await this.reportStatus('logged_out');
  }

  // ── Public: getQrData ─────────────────────────────────────────
  getQrData() { return this.qrData; }

  // ── Handle incoming message ───────────────────────────────────
  async _handleIncoming(msg) {
    // ── Resolve display name ──────────────────────────────────
    let displayName = msg.from;
    let fromContext = 'unknown';
    try {
      const contact = await msg.getContact();
      displayName = contact.pushname || contact.name || msg.from;
      // A contact with a name saved is "known"
      fromContext = (contact.name || contact.pushname) ? 'known' : 'unknown';
    } catch { /* ignore */ }

    // ── Media: download + classify ────────────────────────────
    let mediaBuffer = null;
    let mediaResult = { media_type: 'text', media_summary: null, risk_level: 'low', ocr_text: null };

    if (msg.hasMedia) {
      try {
        const dl = await msg.downloadMedia();
        if (dl?.data) {
          mediaBuffer = Buffer.from(dl.data, 'base64');
        }
      } catch (err) {
        this.log(`⚠ Media download failed: ${err.message}`);
      }

      mediaResult = await classifyAttachment(msg, {
        runOcr:      process.env.OCR_ENABLED === 'true',
        mediaBuffer,
        fromContext,
      });
    }

    const type    = resolveMediaType(msg);
    const summary = mediaResult.media_summary || null;

    // ── Body: enrich for non-text types ──────────────────────
    let body = String(msg.body || '').trim();

    if (type === 'location' && msg.location) {
      const loc = msg.location;
      body = body || `[location: ${loc.latitude},${loc.longitude}${loc.description ? ' — ' + loc.description : ''}]`;
    } else if ((type === 'vcard') && msg.vCards?.length) {
      body = body || msg.vCards.map(v => `[vcard: ${v.slice(0, 120)}]`).join('\n');
    } else if (!body) {
      const promptLabel = summarizeForPrompt(mediaResult);
      body = promptLabel || `[${type}]`;
    }

    // ── First URL in message ──────────────────────────────────
    let firstLink = null;
    try {
      if (msg.links?.length) firstLink = msg.links[0].link;
    } catch { /* ignore */ }

    this.log(`← [${displayName}] [${type}]: ${body.slice(0, 80)}`);

    // ── Is quoted message from me? ────────────────────────────
    let replyToMe = false;
    if (msg.hasQuotedMsg) {
      try {
        const quoted = await msg.getQuotedMessage();
        replyToMe = Boolean(quoted?.fromMe);
      } catch { /* ignore */ }
    }

    // ── Is this a group chat? ─────────────────────────────────
    let isGroup = false;
    try {
      const chat = await msg.getChat();
      isGroup = Boolean(chat?.isGroup);
    } catch { /* ignore */ }

    // ── Was I mentioned? ──────────────────────────────────────
    let mentionedMe = false;
    try {
      const myWid = this.client?.info?.wid?._serialized;
      if (myWid && Array.isArray(msg.mentionedIds)) {
        mentionedMe = msg.mentionedIds.includes(myWid);
      }
    } catch { /* ignore */ }

    // ── POST to server ────────────────────────────────────────
    try {
      const result = await postWithRetry(
        `${this.orchestratorUrl}/api/ingest/whatsapp`,
        {
          from:              msg.from,
          externalContactId: msg.from,
          displayName,
          body,
          timestamp:     msg.timestamp ? msg.timestamp * 1000 : Date.now(),
          media_type:    type,
          media_summary: summary,
          risk_level:    mediaResult.risk_level,
          ocr_text:      mediaResult.ocr_text  || null,
          first_link:    firstLink,
          is_forwarded:  msg.isForwarded || false,
          is_starred:    msg.isStarred   || false,
          is_gif:        msg.isGif       || false,
          is_group:      isGroup,
          author:        msg.author      || null,
          reply_to_me:   replyToMe,
          mentioned_me:  mentionedMe,
          wa_msg_id:     msg.id._serialized,
        }
      );
      this.log(`✓ Processed — decision: ${formatDecisionForLog(result?.decision)} | autoSent: ${result?.autoSent || false}`);
    } catch (err) {
      const serverMessage = err?.response?.data?.error || err?.response?.data?.message || err?.response?.data;
      this.log(`✗ Error processing message: ${err.message}${serverMessage ? ' — ' + String(serverMessage).slice(0, 180) : ''}`);
    }
  }

  // ── Outgoing queue polling ────────────────────────────────────
  _startOutgoingLoop() {
    const poll = async () => {
      if (!this.running) return;
      try {
        const res = await axios.get(
          `${this.orchestratorUrl}/api/bridge/pending-outgoing`,
          { params: { channel: 'whatsapp', limit: 5, bridge: 'whatsapp-browser-agent' }, timeout: 10_000 }
        );
        for (const item of (res.data?.outgoing || [])) {
          const to   = String(item.external_contact_id || item.externalContactId || '').trim();
          const text = String(item.body || '');
          try {
            if (!to) throw new Error('Sender guard: missing WhatsApp destination id');
            if (to.includes(',')) throw new Error('Sender guard: refusing multiple WhatsApp recipients');
            if (/\s/.test(to)) throw new Error('Sender guard: WhatsApp destination id contains whitespace');
            if (!text.trim()) throw new Error('Sender guard: empty outgoing body');
            if (item.channel && item.channel !== 'whatsapp') throw new Error(`Sender guard: channel mismatch ${item.channel}`);

            const sentMsg = await this.client.sendMessage(to, text);

            // Register for ack tracking
            if (sentMsg?.id?._serialized) {
              this._pendingAcks.set(sentMsg.id._serialized, item.id);
            }

            await axios.post(
              `${this.orchestratorUrl}/api/bridge/outgoing/${item.id}/sent`,
              { wa_msg_id: sentMsg?.id?._serialized || null },
              { timeout: 5000 }
            );
            this.log(`→ Sent to ${item.display_name || to}: "${text.slice(0, 60)}"`);
          } catch (err) {
            this.log(`✗ Send failed: ${err.message}`);
            await axios.post(
              `${this.orchestratorUrl}/api/bridge/outgoing/${item.id}/failed`,
              { error: err.message }, { timeout: 5000 }
            ).catch(() => {});
          }
        }
      } catch (err) {
        if (err.code !== 'ECONNREFUSED') {
          this.log(`Outgoing poll error: ${err.message}`);
        }
      }
      if (this.running) setTimeout(poll, this.pollMs);
    };
    setTimeout(poll, 3000);
  }

  // ── Report status to server ───────────────────────────────────
  async reportStatus(status, errorLog = null) {
    try {
      await axios.post(
        `${this.orchestratorUrl}/api/agents/${this.channel}/status`,
        { status, errorLog },
        { timeout: 5000 }
      );
    } catch { /* server may be offline */ }
  }

  // ── Logging ───────────────────────────────────────────────────
  log(msg) {
    const ts = new Date().toTimeString().slice(0, 8);
    console.log(`[${ts}] [${this.name}] ${msg}`);
  }
}

module.exports = WhatsAppAgent;
