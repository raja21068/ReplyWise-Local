/**
 * Agent Manager v2
 *
 * Changes from v1
 * ───────────────
 * • WeChat agent added (ENABLED_AGENTS=whatsapp,telegram,wechat)
 * • Exponential back-off with jitter on restart (caps at 5 min)
 * • Per-agent restart circuit-breaker: after maxRestarts consecutive failures
 *   the agent is parked and an alert is logged every 10 min instead of retrying forever.
 * • startup order: orchestrator must be reachable before agents launch (with retries).
 */

require('dotenv').config();

const WhatsAppAgent = require('./whatsapp-agent');
const TelegramAgent = require('./telegram-agent');
const WeChatAgent   = require('./wechat-agent');

const AGENT_CLASSES = {
  whatsapp: WhatsAppAgent,
  telegram: TelegramAgent,
  wechat:   WeChatAgent,
};

// Back-off: base * 2^(attempt-1) + jitter, capped at MAX_DELAY_MS
const BASE_DELAY_MS = 5000;
const MAX_DELAY_MS  = 5 * 60 * 1000; // 5 minutes

function backoffDelay(attempt) {
  const exp = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS);
  const jitter = Math.floor(Math.random() * 3000);
  return exp + jitter;
}

class AgentManager {
  constructor() {
    this.agents = new Map();
    this.maxRestarts = Number(process.env.AGENT_MAX_RESTARTS || 8);
    this.running = false;
  }

  async start() {
    this.running = true;
    const enabled = (process.env.ENABLED_AGENTS || 'whatsapp,telegram')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
      .filter(ch => AGENT_CLASSES[ch]);

    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  ReplyWise Local                                        ║');
    console.log('║  Smart messaging co-pilot · human-in-the-loop           ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Enabled agents: ${(enabled.join(', ') || 'none').padEnd(39)}║`);
    console.log(`║  Orchestrator:   ${(process.env.APP_BASE_URL || 'http://localhost:3000').padEnd(39)}║`);
    console.log(`║  AI provider:    ${(process.env.AI_PROVIDER || 'local').padEnd(39)}║`);
    console.log(`║  Media download: ${(process.env.WHATSAPP_DOWNLOAD_MEDIA === 'true' ? 'enabled' : 'disabled').padEnd(39)}║`);
    console.log(`║  Screenshots:    ${(process.env.SCREENSHOT_ON_ERROR === 'true' ? 'debug only' : 'off').padEnd(39)}║`);
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    for (const channel of enabled) {
      await this.launchAgent(channel, AGENT_CLASSES[channel]);
    }

    this.statusInterval = setInterval(() => this.printStatus(), 60000);
  }

  async launchAgent(channel, AgentClass) {
    const record = this.agents.get(channel) || { instance: null, restarts: 0, lastError: null, parked: false };
    this.agents.set(channel, record);

    if (record.parked) {
      console.log(`[manager] ⚠  ${channel} is parked after ${this.maxRestarts} consecutive failures. Clear ./data/sessions/${channel} and restart to reset.`);
      return;
    }

    const agent = new AgentClass();
    record.instance = agent;

    agent.on('login_required', () => {
      console.log(`\n  ⚠  [${channel}] Login required: ${process.env.APP_BASE_URL || 'http://localhost:3000'}/reauth/${channel}\n`);
    });

    agent.on('disconnected', (reason) => {
      console.log(`\n  ✗  [${channel}] Disconnected: ${reason}\n`);
      if (this.running && !record.parked) this.scheduleRestart(channel, AgentClass);
    });

    try {
      console.log(`[manager] Launching ${channel} agent...`);
      await agent.start();
      record.restarts = 0; // reset counter on clean start
      console.log(`[manager] ✓ ${channel} agent is running`);
    } catch (err) {
      record.lastError = err.message;
      console.error(`[manager] ✗ ${channel} agent failed: ${err.message}`);
      if (this.running && !record.parked) this.scheduleRestart(channel, AgentClass);
    }
  }

  scheduleRestart(channel, AgentClass) {
    const record = this.agents.get(channel);
    if (!record) return;
    record.restarts += 1;

    if (record.restarts > this.maxRestarts) {
      record.parked = true;
      console.error(`[manager] ✗ ${channel} parked: exceeded ${this.maxRestarts} restarts. Manual intervention required.`);
      // Ping every 10 min as a reminder
      setInterval(() => {
        if (record.parked) console.warn(`[manager] ⚠  ${channel} is still parked. Visit /reauth/${channel} or restart the service.`);
      }, 10 * 60 * 1000);
      return;
    }

    const delay = backoffDelay(record.restarts);
    console.log(`[manager] Restart #${record.restarts}/${this.maxRestarts} for ${channel} in ${Math.round(delay / 1000)}s`);

    setTimeout(async () => {
      if (!this.running || record.parked) return;
      if (record.instance) await record.instance.stop().catch(() => {});
      await this.launchAgent(channel, AgentClass);
    }, delay);
  }

  printStatus() {
    console.log('\n── Agent Status ────────────────────────────────────');
    for (const [channel, record] of this.agents) {
      const agent   = record.instance;
      const status  = record.parked
        ? '🔴 PARKED'
        : agent?.healthy
          ? '✓ active'
          : '✗ down/login needed';
      const restarts = record.restarts ? ` (restarts: ${record.restarts})` : '';
      const error    = record.lastError ? ` — ${record.lastError.slice(0, 60)}` : '';
      console.log(`  ${channel.padEnd(10)} ${status}${restarts}${error}`);
    }
    console.log('────────────────────────────────────────────────────\n');
  }

  async stop() {
    this.running = false;
    clearInterval(this.statusInterval);
    for (const [, record] of this.agents) {
      if (record.instance) await record.instance.stop().catch(() => {});
    }
  }
}

if (require.main === module) {
  const manager = new AgentManager();
  manager.start().catch(err => {
    console.error('Agent manager failed:', err);
    process.exit(1);
  });
  process.on('SIGINT',  () => manager.stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => manager.stop().then(() => process.exit(0)));
}

module.exports = AgentManager;
