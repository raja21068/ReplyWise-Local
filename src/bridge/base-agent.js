/**
 * BaseAgent — Universal browser automation agent for RelationshipOS.
 *
 * Each messaging platform subclass implements:
 *   - getLoginUrl()          → URL of the web client
 *   - isLoggedIn(page)       → boolean: is the session still alive?
 *   - handleLogin(page)      → perform QR scan / OTP / cookie login
 *   - installMessageWatcher(page) → inject DOM observer or WS intercept
 *   - sendMessageViaUI(page, { externalContactId, displayName, body })
 *                            → find chat, type message, click send
 *
 * The base class handles:
 *   - Launching Playwright with persistent session
 *   - Session recovery & heartbeat
 *   - Incoming message → orchestrator POST
 *   - Outgoing queue polling → sendMessageViaUI
 *   - Health reporting to the database
 *   - Screenshot-on-error debugging
 *   - Human typing simulation
 */

const { chromium } = require('playwright');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

class BaseAgent extends EventEmitter {
  constructor({ channel, name }) {
    super();
    this.channel = channel;
    this.name = name || channel;
    this.browser = null;
    this.page = null;
    this.running = false;
    this.healthy = false;
    this.lastError = null;

    // Config
    this.orchestratorUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
    this.sessionDir = path.resolve(
      process.env.SESSION_DIR || './data/sessions',
      this.channel
    );
    this.headless = process.env.BROWSER_HEADLESS !== 'false';
    this.screenshotDir = process.env.SCREENSHOT_DIR || './data/screenshots';
    this.healthCheckInterval = (Number(process.env.HEALTH_CHECK_INTERVAL) || 30) * 1000;
    this.typingDelayMin = Number(process.env.TYPING_DELAY_MIN) || 30;
    this.typingDelayMax = Number(process.env.TYPING_DELAY_MAX) || 120;
    this.actionDelayMin = Number(process.env.ACTION_DELAY_MIN) || 500;
    this.actionDelayMax = Number(process.env.ACTION_DELAY_MAX) || 2000;
    this.outgoingPollMs = Number(process.env.BRIDGE_POLL_MS) || 3000;

    // Ensure directories exist
    fs.mkdirSync(this.sessionDir, { recursive: true });
    fs.mkdirSync(this.screenshotDir, { recursive: true });
  }

  // ── Subclass contract (override these) ──────────────────

  /** URL of the web client */
  getLoginUrl() {
    throw new Error(`${this.name}: getLoginUrl() not implemented`);
  }

  /** Check if the session is still valid */
  async isLoggedIn(page) {
    throw new Error(`${this.name}: isLoggedIn() not implemented`);
  }

  /** Perform interactive login (QR, OTP, etc.) */
  async handleLogin(page) {
    throw new Error(`${this.name}: handleLogin() not implemented`);
  }

  /** Install a watcher that calls this.onIncomingMessage() */
  async installMessageWatcher(page) {
    throw new Error(`${this.name}: installMessageWatcher() not implemented`);
  }

  /** Navigate to the right chat and type + send the message */
  async sendMessageViaUI(page, { externalContactId, displayName, body }) {
    throw new Error(`${this.name}: sendMessageViaUI() not implemented`);
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async start() {
    this.log('Starting agent...');
    this.running = true;

    try {
      // Launch persistent browser context (session survives restarts)
      this.browser = await chromium.launchPersistentContext(this.sessionDir, {
        headless: this.headless,
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'Asia/Karachi',
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-dev-shm-usage',
        ],
      });

      this.page = this.browser.pages()[0] || (await this.browser.newPage());

      // Remove automation signals
      await this.page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        // Remove Playwright detection
        delete window.__playwright;
        delete window.__pw_manual;
      });

      // Navigate to the web client
      this.log(`Navigating to ${this.getLoginUrl()}`);
      await this.page.goto(this.getLoginUrl(), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.randomDelay(2000, 4000);

      // Check login status
      const loggedIn = await this.isLoggedIn(this.page);
      if (!loggedIn) {
        this.log('Session not found — login required');
        await this.reportStatus('login_required');
        await this.handleLogin(this.page);
      }

      this.log('Session active — installing message watcher');
      await this.reportStatus('active');
      this.healthy = true;

      // Expose the callback function for the page to call
      await this.page.exposeFunction('__rosOnMessage', (data) => {
        this.onIncomingMessage(data).catch((err) => {
          this.log(`Error processing incoming: ${err.message}`);
        });
      });

      // Install the platform-specific message watcher
      await this.installMessageWatcher(this.page);

      // Start outgoing message loop
      this.startOutgoingLoop();

      // Start health check loop
      this.startHealthLoop();

      this.log('Agent is fully running');
    } catch (err) {
      this.lastError = err.message;
      this.log(`FATAL: ${err.message}`);
      if (process.env.SCREENSHOT_ON_ERROR === 'true') await this.screenshotError('start-failure');
      await this.reportStatus('error', err.message);
      throw err;
    }
  }

  async stop() {
    this.log('Stopping agent...');
    this.running = false;
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // already closed
      }
    }
    await this.reportStatus('stopped');
    this.log('Agent stopped');
  }

  // ── Incoming message handler ──────────────────────────────

  async onIncomingMessage({ from, displayName, body, timestamp }) {
    if (!body || !String(body).trim()) return;
    this.log(`← [${displayName || from}]: ${body.slice(0, 80)}...`);

    try {
      await axios.post(`${this.orchestratorUrl}/api/ingest/${this.channel}`, {
        from: String(from).trim(),
        externalContactId: String(from).trim(),
        displayName: displayName || from,
        body: String(body).trim(),
        timestamp: timestamp || new Date().toISOString(),
      }, { timeout: 15000 });
    } catch (err) {
      this.log(`Failed to POST incoming to orchestrator: ${err.message}`);
    }
  }

  // ── Outgoing message loop ─────────────────────────────────

  startOutgoingLoop() {
    const poll = async () => {
      if (!this.running) return;
      try {
        const res = await axios.get(`${this.orchestratorUrl}/api/bridge/pending-outgoing`, {
          params: { channel: this.channel, limit: 5 },
          timeout: 10000,
        });
        const items = res.data?.outgoing || [];
        for (const item of items) {
          try {
            await this.randomDelay(this.actionDelayMin, this.actionDelayMax);
            await this.sendMessageViaUI(this.page, {
              externalContactId: item.external_contact_id || item.externalContactId,
              displayName: item.display_name || item.displayName || item.contact?.displayName,
              body: item.body,
            });
            await axios.post(
              `${this.orchestratorUrl}/api/bridge/outgoing/${item.id}/sent`,
              {},
              { timeout: 10000 }
            );
            this.log(`→ [${item.display_name || item.externalContactId}]: ${item.body.slice(0, 60)}...`);
          } catch (err) {
            this.log(`Failed to send outgoing ${item.id}: ${err.message}`);
            if (process.env.SCREENSHOT_ON_ERROR === 'true') await this.screenshotError(`send-fail-${item.id}`);
            try {
              await axios.post(
                `${this.orchestratorUrl}/api/bridge/outgoing/${item.id}/failed`,
                { error: err.message },
                { timeout: 5000 }
              );
            } catch {
              // ignore
            }
          }
        }
      } catch (err) {
        if (err.code !== 'ECONNREFUSED') {
          this.log(`Outgoing poll error: ${err.message}`);
        }
      }
      if (this.running) {
        setTimeout(poll, this.outgoingPollMs);
      }
    };
    setTimeout(poll, 2000);
  }

  // ── Health check loop ─────────────────────────────────────

  startHealthLoop() {
    const check = async () => {
      if (!this.running) return;
      try {
        const loggedIn = await this.isLoggedIn(this.page);
        if (loggedIn) {
          this.healthy = true;
          await this.reportStatus('active');
        } else {
          this.healthy = false;
          this.log('Session lost — needs re-authentication');
          await this.reportStatus('login_required');
          this.emit('login_required');
        }
      } catch (err) {
        this.healthy = false;
        this.lastError = err.message;
        await this.reportStatus('error', err.message);
      }
      if (this.running) {
        setTimeout(check, this.healthCheckInterval);
      }
    };
    setTimeout(check, this.healthCheckInterval);
  }

  // ── Report status to orchestrator DB ──────────────────────

  async reportStatus(status, errorLog = null) {
    try {
      await axios.post(`${this.orchestratorUrl}/api/agents/${this.channel}/status`, {
        status,
        errorLog,
      }, { timeout: 5000 });
    } catch {
      // Orchestrator might be down — not critical
    }
  }

  // ── Human-like typing simulation ──────────────────────────

  async humanType(page, selector, text) {
    await page.click(selector);
    await this.randomDelay(200, 500);
    for (const char of text) {
      await page.keyboard.type(char, {
        delay: this.randomInt(this.typingDelayMin, this.typingDelayMax),
      });
    }
  }

  /** Type into an already-focused element */
  async humanTypeIntoFocused(page, text) {
    for (const char of text) {
      await page.keyboard.type(char, {
        delay: this.randomInt(this.typingDelayMin, this.typingDelayMax),
      });
    }
  }

  // ── Utility ───────────────────────────────────────────────

  randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async randomDelay(min, max) {
    const ms = this.randomInt(min || 500, max || 2000);
    return new Promise((r) => setTimeout(r, ms));
  }

  async screenshotError(label) {
    if (process.env.SCREENSHOT_ON_ERROR !== 'true') return;
    try {
      const filename = `${this.channel}-${label}-${Date.now()}.png`;
      const filepath = path.join(this.screenshotDir, filename);
      await this.page.screenshot({ path: filepath, fullPage: true });
      this.log(`Screenshot saved: ${filepath}`);
    } catch {
      // page might be dead
    }
  }

  /** Get a live screenshot (for re-auth UI) */
  async getScreenshotBuffer() {
    try {
      if (process.env.ENABLE_LIVE_SCREENSHOTS !== 'true') return null;
      return await this.page.screenshot({ type: 'png' });
    } catch {
      return null;
    }
  }

  log(msg) {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] [${this.name}] ${msg}`);
  }
}

module.exports = BaseAgent;
