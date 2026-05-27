/**
 * Telegram Agent — Playwright automation of web.telegram.org/a
 *
 * Login: Phone number + OTP code (first time only, then session persists).
 * Message detection: Intercepts WebSocket frames for real-time incoming messages.
 * Sending: Finds the chat by contact name, types into the message input, presses Enter.
 *
 * v2 additions (media parity with WhatsApp agent):
 * • Detects media type from Telegram WebSocket frames (photo, document, sticker, voice, video)
 * • Builds media_summary string from available metadata (file_name, mime_type, duration)
 * • DOM observer also checks for media thumbnail CSS classes to classify message type
 * • Passes media_type + media_summary to /api/ingest/telegram
 */

const BaseAgent = require('./base-agent');

// ── Telegram media type mapping ───────────────────────────────

const TG_TYPE_MAP = {
  messageMediaPhoto:    'image',
  messageMediaDocument: 'file',
  messageMediaGeo:      'text',       // location — treat as text
  messageMediaContact:  'text',
  messageMediaPoll:     'text',
  messageMediaWebPage:  'text',
  messageMediaUnsupported: 'unknown',
};

// Detect document sub-types from MIME or attributes
function resolveTgMediaType(mediaObj) {
  if (!mediaObj) return 'text';
  const type = mediaObj._ || mediaObj.type || '';
  if (type === 'messageMediaPhoto') return 'image';
  if (type === 'messageMediaDocument') {
    const attrs = mediaObj.document?.attributes || [];
    if (attrs.some(a => a._ === 'documentAttributeVideo'))  return 'video';
    if (attrs.some(a => a._ === 'documentAttributeAudio'))  return 'audio';
    if (attrs.some(a => a._ === 'documentAttributeSticker')) return 'sticker';
    if (attrs.some(a => a._ === 'documentAttributeAnimated')) return 'image'; // GIF
    const mime = mediaObj.document?.mime_type || '';
    if (mime.startsWith('image/'))  return 'image';
    if (mime.startsWith('audio/') || mime.includes('ogg')) return 'audio';
    if (mime.startsWith('video/'))  return 'video';
    return 'file';
  }
  return TG_TYPE_MAP[type] || 'text';
}

function buildTgMediaSummary(mediaObj) {
  if (!mediaObj) return null;
  const parts = [];
  const doc = mediaObj.document;
  if (doc) {
    const nameAttr = (doc.attributes || []).find(a => a.file_name);
    if (nameAttr?.file_name) parts.push(`file: "${nameAttr.file_name}"`);
    if (doc.mime_type)       parts.push(`(${doc.mime_type})`);
    const audioAttr = (doc.attributes || []).find(a => a._ === 'documentAttributeAudio');
    if (audioAttr?.duration) parts.push(`duration: ${audioAttr.duration}s`);
    if (doc.size)            parts.push(`${Math.round(doc.size / 1024)}KB`);
  }
  if (mediaObj.photo) parts.push('photo');
  return parts.length ? parts.join(' · ') : null;
}

class TelegramAgent extends BaseAgent {
  constructor() {
    super({ channel: 'telegram', name: 'Telegram' });
    this.knownMessageIds = new Set();
  }

  getLoginUrl() {
    return 'https://web.telegram.org/a/';
  }

  async isLoggedIn(page) {
    try {
      // Telegram Web A shows the chat list when logged in.
      // If we see the chat list container, we're in.
      const chatList = await page.$('#LeftColumn .chat-list, .ChatList, [class*="ChatList"]');
      if (chatList) return true;

      // Also check for the middle column (open chat)
      const middleCol = await page.$('#MiddleColumn, [class*="MiddleColumn"]');
      if (middleCol) return true;

      // Check if login screen is showing
      const loginScreen = await page.$('.auth-form, [class*="AuthPhoneNumber"], #auth-qr-form');
      if (loginScreen) return false;

      // Give it a moment — page might still be loading
      await page.waitForTimeout(3000);
      const chatListRetry = await page.$('#LeftColumn .chat-list, .ChatList, [class*="ChatList"]');
      return !!chatListRetry;
    } catch {
      return false;
    }
  }

  async handleLogin(page) {
    this.log('Waiting for manual login...');
    this.log('===========================================================');
    this.log('  Open the re-auth page or watch the browser to log in:');
    this.log(`  ${this.orchestratorUrl}/reauth/telegram`);
    this.log('  Enter your phone number and the OTP code from Telegram.');
    this.log('  Session will persist after first login.');
    this.log('===========================================================');

    // Wait until the chat list appears (user completed login)
    try {
      await page.waitForSelector(
        '#LeftColumn .chat-list, .ChatList, [class*="ChatList"]',
        { timeout: 300000 } // 5 minutes to log in
      );
      this.log('Login successful!');
    } catch {
      throw new Error('Login timed out after 5 minutes');
    }
  }

  async installMessageWatcher(page) {
    // Strategy 1: WebSocket interception (most reliable for Telegram)
    page.on('websocket', (ws) => {
      this.log(`WebSocket connected: ${ws.url().slice(0, 60)}...`);

      ws.on('framereceived', async ({ payload }) => {
        try {
          await this.parseWebSocketFrame(payload);
        } catch {
          // Not every frame is a message — ignore parse errors
        }
      });
    });

    // Strategy 2: DOM mutation observer as fallback
    await page.evaluate(() => {
      // Track messages we've already seen
      const seen = new Set();

      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;

            // Look for message bubbles
            const msgElements = node.matches?.('[class*="Message "], [class*="message-list-item"]')
              ? [node]
              : Array.from(node.querySelectorAll?.('[class*="Message "], [class*="message-list-item"]') || []);

            for (const el of msgElements) {
              // Skip outgoing messages
              if (el.classList?.toString().includes('own') || el.querySelector?.('[class*="own"]')) continue;

              const msgId = el.getAttribute('data-message-id') || el.id || el.textContent?.slice(0, 50);
              if (!msgId || seen.has(msgId)) continue;
              seen.add(msgId);

              // Extract message text
              const textEl = el.querySelector('[class*="text-content"], [class*="MessageText"], .text-entity-container');
              const text = textEl?.textContent?.trim();
              if (!text) continue;

              // Extract sender info from the chat header
              const chatTitle = document.querySelector(
                '#MiddleColumn [class*="ChatInfo"] h3, [class*="TopBar"] [class*="title"], .chat-info .title'
              );
              const senderName = chatTitle?.textContent?.trim() || 'Unknown';

              // Get the chat ID from URL or data attributes
              const url = window.location.hash || window.location.pathname;
              const chatIdMatch = url.match(/#(-?\d+)/) || url.match(/\/(-?\d+)/);
              const chatId = chatIdMatch ? chatIdMatch[1] : senderName;

              window.__rosOnMessage({
                from: `tg_${chatId}`,
                displayName: senderName,
                body: text,
                timestamp: new Date().toISOString(),
              });
            }
          }
        }
      });

      // Observe the message list container
      const tryObserve = () => {
        const container = document.querySelector(
          '#MiddleColumn [class*="MessageList"], .messages-container, [class*="messages-layout"]'
        );
        if (container) {
          observer.observe(container, { childList: true, subtree: true });
          console.log('[ROS] Message observer installed on message list');
        } else {
          // Also observe body as ultra-fallback
          observer.observe(document.body, { childList: true, subtree: true });
          console.log('[ROS] Message observer installed on body (fallback)');
        }
      };

      tryObserve();
      // Re-install if the DOM structure changes (e.g., switching chats)
      setInterval(tryObserve, 5000);
    });

    this.log('Message watcher installed (WebSocket + DOM fallback)');
  }

  async parseWebSocketFrame(payload) {
    // Telegram Web uses a custom binary protocol over WebSocket.
    // The text messages are embedded as JSON-ish data in some frames.
    // This is a best-effort parser — the protocol isn't officially documented.
    if (typeof payload !== 'string') return;
    if (payload.length < 20) return;

    try {
      const data = JSON.parse(payload);
      // Look for message-like structures
      if (data._ === 'updateNewMessage' || data._?.includes?.('message')) {
        const msg = data.message || data;
        if (msg.out) return; // Skip outgoing

        const fromId     = msg.from_id?.user_id || msg.peer_id?.user_id || 'unknown';
        const textBody   = msg.message || msg.text || '';
        const mediaObj   = msg.media || null;
        const mediaType  = mediaObj ? resolveTgMediaType(mediaObj) : 'text';
        const mediaSummary = mediaObj ? buildTgMediaSummary(mediaObj) : null;

        // Only ingest if there's text or media (skip empty frames)
        if (!textBody && !mediaObj) return;

        const body = textBody || `[${mediaType}]`;

        await this.onIncomingMessage({
          from: `tg_${fromId}`,
          displayName: `User ${fromId}`,
          body,
          media_type: mediaType,
          media_summary: mediaSummary,
        });
      }
    } catch {
      // Not JSON — might be binary TL protocol. Ignore.
    }
  }

  // Override to pass media_type + media_summary through to orchestrator
  async onIncomingMessage({ from, displayName, body, timestamp, media_type, media_summary }) {
    if (!body || !String(body).trim()) return;
    this.log(`← [${displayName || from}]: ${body.slice(0, 80)}`);
    const axios = require('axios');
    try {
      await axios.post(`${this.orchestratorUrl}/api/ingest/${this.channel}`, {
        from: String(from).trim(),
        externalContactId: String(from).trim(),
        displayName: displayName || from,
        body: String(body).trim(),
        timestamp: timestamp || new Date().toISOString(),
        media_type: media_type || 'text',
        media_summary: media_summary || null,
      }, { timeout: 15000 });
    } catch (err) {
      this.log(`Failed to POST incoming to orchestrator: ${err.message}`);
    }
  }

  async sendMessageViaUI(page, { externalContactId, displayName, body }) {
    const searchName = displayName || externalContactId.replace(/^tg_/, '');

    // Step 1: Open search
    this.log(`Searching for chat: ${searchName}`);
    const searchInput = await page.$(
      '#LeftColumn [class*="SearchInput"] input, [class*="search-input"] input, #telegram-search-input'
    );

    if (searchInput) {
      await searchInput.click();
      await this.randomDelay(300, 600);
      await searchInput.fill('');
      await this.humanTypeIntoFocused(page, searchName);
      await this.randomDelay(1000, 2000);

      // Step 2: Click the matching chat result
      const chatResult = await page.$(
        `[class*="ListItem"] :text-is("${searchName}"), [class*="search-result"] :text("${searchName}")`
      );
      if (chatResult) {
        await chatResult.click();
        await this.randomDelay(500, 1000);
      } else {
        // Try pressing Enter to open first result
        await page.keyboard.press('Enter');
        await this.randomDelay(500, 1000);
      }

      // Clear search
      await page.keyboard.press('Escape');
      await this.randomDelay(300, 500);
    }

    // Step 3: Type into the message input
    const msgInput = await page.$(
      '#editable-message-text, [class*="composer"] [contenteditable], [class*="ComposerInput"] [contenteditable]'
    );

    if (!msgInput) {
      throw new Error('Could not find message input field');
    }

    await msgInput.click();
    await this.randomDelay(200, 500);

    // Clear any existing text
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');

    // Type the message with human-like delays
    await this.humanTypeIntoFocused(page, body);
    await this.randomDelay(300, 800);

    // Step 4: Press Enter to send
    await page.keyboard.press('Enter');
    this.log(`Message sent to ${searchName}`);
    await this.randomDelay(500, 1000);
  }
}

// ── Standalone launch ────────────────────────────────────
if (require.main === module) {
  require('dotenv').config();
  const agent = new TelegramAgent();
  agent.start().catch((err) => {
    console.error('Telegram agent failed:', err);
    process.exit(1);
  });
  process.on('SIGINT', () => agent.stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => agent.stop().then(() => process.exit(0)));
}

module.exports = TelegramAgent;
