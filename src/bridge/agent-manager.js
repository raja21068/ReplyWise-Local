/**
 * Agent Manager — launches only the 2 killer MVP channels:
 *   - WhatsApp via whatsapp-web.js
 *   - Telegram via Playwright browser session
 *
 * No official messaging API keys. No bot tokens. No autonomous sending.
 */
require('dotenv').config();

const WhatsAppAgent = require('./whatsapp-agent');
const TelegramAgent = require('./telegram-agent');

const AGENT_CLASSES = { whatsapp: WhatsAppAgent, telegram: TelegramAgent };

class AgentManager {
  constructor() {
    this.agents = new Map();
    this.maxRestarts = 5;
    this.restartDelayMs = 10000;
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
    console.log('║  ConversationOS Local                                   ║');
    console.log('║  It tells you whether replying is a good idea.          ║');
    console.log('║  Zero messaging API keys · Browser-session agents       ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Enabled agents: ${(enabled.join(', ') || 'none').padEnd(39)}║`);
    console.log(`║  Orchestrator:   ${(process.env.APP_BASE_URL || 'http://localhost:3000').padEnd(39)}║`);
    console.log(`║  AI provider:    ${(process.env.AI_PROVIDER || 'local').padEnd(39)}║`);
    console.log(`║  Screenshots:    ${(process.env.SCREENSHOT_ON_ERROR === 'true' ? 'debug only' : 'off').padEnd(39)}║`);
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    for (const channel of enabled) {
      await this.launchAgent(channel, AGENT_CLASSES[channel]);
    }
    this.statusInterval = setInterval(() => this.printStatus(), 60000);
  }

  async launchAgent(channel, AgentClass) {
    const record = this.agents.get(channel) || { instance: null, restarts: 0, lastError: null };
    this.agents.set(channel, record);
    const agent = new AgentClass();
    record.instance = agent;

    agent.on('login_required', () => {
      console.log(`\n  ⚠  [${channel}] Login required: ${process.env.APP_BASE_URL || 'http://localhost:3000'}/reauth/${channel}\n`);
    });
    agent.on('disconnected', (reason) => {
      console.log(`\n  ✗  [${channel}] Disconnected: ${reason}\n`);
      if (this.running && record.restarts < this.maxRestarts) this.scheduleRestart(channel, AgentClass);
    });

    try {
      console.log(`[manager] Launching ${channel} agent...`);
      await agent.start();
      console.log(`[manager] ✓ ${channel} agent is running`);
    } catch (err) {
      record.lastError = err.message;
      console.error(`[manager] ✗ ${channel} agent failed: ${err.message}`);
      if (this.running && record.restarts < this.maxRestarts) this.scheduleRestart(channel, AgentClass);
    }
  }

  scheduleRestart(channel, AgentClass) {
    const record = this.agents.get(channel);
    if (!record) return;
    record.restarts += 1;
    const delay = this.restartDelayMs * record.restarts;
    console.log(`[manager] Restart #${record.restarts} for ${channel} in ${delay / 1000}s`);
    setTimeout(async () => {
      if (!this.running) return;
      if (record.instance) await record.instance.stop().catch(() => {});
      await this.launchAgent(channel, AgentClass);
    }, delay);
  }

  printStatus() {
    console.log('\n── Agent Status ────────────────────────────────────');
    for (const [channel, record] of this.agents) {
      const agent = record.instance;
      const status = agent?.healthy ? '✓ active' : '✗ down/login needed';
      const restarts = record.restarts ? ` (restarts: ${record.restarts})` : '';
      const error = record.lastError ? ` — ${record.lastError.slice(0, 60)}` : '';
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
  process.on('SIGINT', () => manager.stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => manager.stop().then(() => process.exit(0)));
}

module.exports = AgentManager;
