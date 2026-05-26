/**
 * WhatsApp Agent — uses whatsapp-web.js (Puppeteer-based).
 *
 * This is a special case: whatsapp-web.js manages its own browser instance,
 * so we don't use Playwright's launchPersistentContext. Instead, we wrap
 * the whatsapp-web.js Client in the BaseAgent lifecycle pattern.
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

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

    fs.mkdirSync(this.sessionDir, { recursive: true });
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

    // ── QR code for first-time login ───────────────────────
    this.client.on('qr', (qr) => {
      this.qrData = qr;
      this.log('QR code received — scan with your phone');
      qrcode.generate(qr, { small: true });
      this.reportStatus('login_required');
      this.emit('qr', qr);
    });

    // ── Authenticated ──────────────────────────────────────
    this.client.on('authenticated', () => {
      this.log('Authenticated successfully');
      this.qrData = null;
    });

    // ── Ready ──────────────────────────────────────────────
    this.client.on('ready', () => {
      this.log('Client is ready — listening for messages');
      this.healthy = true;
      this.reportStatus('active');
      this.startOutgoingLoop();
    });

    // ── Incoming messages ──────────────────────────────────
    this.client.on('message', async (msg) => {
      if (msg.fromMe) return;
      if (msg.isStatus) return;

      try {
        const contact = await msg.getContact();
        const displayName = contact.pushname || contact.name || msg.from;

        this.log(`← [${displayName}]: ${msg.body.slice(0, 80)}`);

        await axios.post(`${this.orchestratorUrl}/api/ingest/whatsapp`, {
          from: msg.from,
          externalContactId: msg.from,
          displayName,
          body: msg.body,
          timestamp: msg.timestamp ? msg.timestamp * 1000 : Date.now(),
        }, { timeout: 15000 });
      } catch (err) {
        this.log(`Error processing incoming: ${err.message}`);
      }
    });

    // ── Disconnected ───────────────────────────────────────
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

    // ── Initialize ─────────────────────────────────────────
    await this.client.initialize();
  }

  async stop() {
    this.log('Stopping...');
    this.running = false;
    if (this.client) {
      try {
        await this.client.destroy();
      } catch {
        // already destroyed
      }
    }
    this.reportStatus('stopped');
  }

  // ── Send message via whatsapp-web.js API ────────────────

  async sendMessageViaUI(page, { externalContactId, body }) {
    if (!this.client) throw new Error('Client not initialized');
    await this.randomDelay(this.actionDelayMin, this.actionDelayMax);
    await this.client.sendMessage(externalContactId, body);
  }

  // ── Outgoing queue polling ──────────────────────────────

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
          }
        }
      } catch (err) {
        if (err.code !== 'ECONNREFUSED') {
          this.log(`Outgoing poll error: ${err.message}`);
        }
      }
      if (this.running) setTimeout(poll, this.outgoingPollMs);
    };
    setTimeout(poll, 2000);
  }

  // ── Utility ─────────────────────────────────────────────

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

  /** For re-auth UI: return QR string */
  getQrData() {
    return this.qrData;
  }

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

// ── Standalone launch ────────────────────────────────────
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
