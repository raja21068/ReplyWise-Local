/**
 * WeChat Agent — Playwright automation of web.wechat.com (wx.qq.com)
 *
 * Login: QR scan from mobile app (first time only, session persists in profile dir).
 * Message detection: DOM MutationObserver on the message panel.
 * Sending: Search contact by name, open chat, type + Enter.
 *
 * v2 additions (media parity with WhatsApp / Telegram agents):
 * ─────────────────────────────────────────────────────────────
 * • DOM-based media type detection inside extractMessage() for all WeChat Web
 *   message bubble shapes: image, audio (voice), video, sticker, file.
 * • resolveWeChatMediaType(node) and buildWeChatMediaSummary(node) helpers
 *   are defined both as browser-side inline functions (used inside the
 *   MutationObserver page.evaluate block) and as Node.js module-level
 *   equivalents (used in onIncomingMessage for post-processing / enrichment).
 * • onIncomingMessage() overridden to forward media_type + media_summary to
 *   /api/ingest/wechat — matches the WhatsApp and Telegram ingest payload shape.
 * • Media-only messages (no caption text) use "[<type>]" as the body fallback
 *   so the base-agent guard clause doesn't silently discard them.
 *
 * NOTES
 * ─────
 * • web.wechat.com only supports personal WeChat accounts.
 * • Corporate/Work WeChat (企业微信) is a different product — use WeChat Work APIs for that.
 * • WeChat blocks aggressive automation; human-like delays + anti-detect flags are baked in.
 * • The QR code is displayed in the terminal and also served at /reauth/wechat as a live screenshot.
 */

'use strict';

const BaseAgent = require('./base-agent');
const axios     = require('axios');

// ─────────────────────────────────────────────────────────────────────────────
// Node.js-side helpers
//
// These mirror the browser-side _wcResolveMediaType / _wcBuildMediaSummary
// functions that run inside page.evaluate(). They operate on the plain object
// that __rosOnMessage serialises out of the browser, not on live DOM nodes.
// Use them in onIncomingMessage() for validation, logging, or enrichment.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a canonical media_type string from the serialised message data
 * emitted by the browser-side watcher.
 *
 * @param {object} msgData  Plain object from __rosOnMessage
 * @returns {'text'|'image'|'audio'|'video'|'sticker'|'file'|'unknown'}
 */
function resolveWeChatMediaType(msgData) {
  const raw = (msgData?.media_type || 'text').toLowerCase();
  const allowed = ['text', 'image', 'audio', 'video', 'sticker', 'file', 'unknown'];
  return allowed.includes(raw) ? raw : 'unknown';
}

/**
 * Build (or validate / enrich) a human-readable media_summary string from the
 * serialised message data.  The browser already produces a summary string;
 * this function normalises it and adds a fallback so downstream code always
 * gets a non-null string for media messages.
 *
 * @param {object} msgData        Plain object from __rosOnMessage
 * @param {string} resolvedType   Output of resolveWeChatMediaType(msgData)
 * @returns {string|null}
 */
function buildWeChatMediaSummary(msgData, resolvedType) {
  if (resolvedType === 'text') return null;

  const raw = typeof msgData?.media_summary === 'string'
    ? msgData.media_summary.trim()
    : '';

  if (raw) return raw;

  // Fallback label so the Decision Engine sees something meaningful
  const labels = {
    image:   'image attachment',
    audio:   'voice message',
    video:   'video attachment',
    sticker: 'sticker',
    file:    'file attachment',
    unknown: 'unknown attachment',
  };
  return labels[resolvedType] || 'attachment';
}

// ─────────────────────────────────────────────────────────────────────────────
// WeChatAgent class
// ─────────────────────────────────────────────────────────────────────────────

class WeChatAgent extends BaseAgent {
  constructor() {
    super({ channel: 'wechat', name: 'WeChat' });
    this._seenMessageKeys = new Set();
  }

  // ── Login URL ─────────────────────────────────────────────

  getLoginUrl() {
    return 'https://web.wechat.com/';
  }

  // ── Session check ─────────────────────────────────────────

  async isLoggedIn(page) {
    try {
      const chatPanel = await page.$('#chatArea, .chat-area, [id="chat-area"], .main-panel');
      if (chatPanel) return true;

      const qrPage = await page.$('.qrcode, #qrcode, .login-panel, [class*="login"]');
      if (qrPage) return false;

      await page.waitForTimeout(3000);
      return !!(await page.$('#chatArea, .chat-area, .main-panel'));
    } catch {
      return false;
    }
  }

  // ── Login flow ────────────────────────────────────────────

  async handleLogin(page) {
    this.log('Waiting for WeChat QR code to load...');

    try {
      await page.waitForSelector('.qrcode img, #qrcode img, [class*="qrcode"] img', { timeout: 30000 });
      this.log('QR code is visible — take a live screenshot at /reauth/wechat or check terminal.');
    } catch {
      this.log('QR selector not found — page may already be loading or structure changed.');
    }

    this.log('===========================================================');
    this.log('  Open WeChat on your phone and scan the QR code.');
    this.log(`  Or visit: ${this.orchestratorUrl}/reauth/wechat`);
    this.log('  Session will persist after first scan.');
    this.log('===========================================================');

    await page.waitForSelector('#chatArea, .chat-area, .main-panel', { timeout: 300000 });
    this.log('WeChat login successful!');
  }

  // ── Message watcher ───────────────────────────────────────

  async installMessageWatcher(page) {
    await page.evaluate(() => {
      const seen = new Set();

      // ── Browser-side media helpers ──────────────────────────
      //
      // These run in the page (DOM) context. They mirror the Node.js-side
      // resolveWeChatMediaType / buildWeChatMediaSummary functions above but
      // work directly on live HTMLElement nodes.
      //
      // WeChat Web message bubbles vary across wx.qq.com / web.wechat.com
      // versions. We check multiple selector / class patterns so detection
      // degrades gracefully when the DOM structure changes.

      /**
       * Inspect a message bubble node and return a canonical media type string.
       * Returns 'text' when no media indicators are found.
       *
       * @param {HTMLElement} node  The message bubble element
       * @returns {'text'|'image'|'audio'|'video'|'sticker'|'file'|'unknown'}
       */
      function _wcResolveMediaType(node) {
        if (!node) return 'text';

        // ── Sticker ─────────────────────────────────────────────
        // Stickers are large single-emoji images or elements with sticker
        // class names. Check before generic image so stickers don't fall
        // through as plain images.
        if (
          node.querySelector('[class*="sticker"], [class*="emoji_type"], [class*="Sticker"]') ||
          node.querySelector('img[class*="sticker"], img[class*="emoji"]') ||
          // Some clients render stickers as a lone <img> with no src extension
          // but wrap it in an element labelled "emoji"
          node.querySelector('[class*="msg_emoji"], [class*="msgEmoji"]')
        ) {
          return 'sticker';
        }

        // ── Image ────────────────────────────────────────────────
        // WeChat Web: .msg_thumb (thumbnail), .msg-image, .message-img,
        // img.msg-img, .img (generic), picture elements inside message bubbles.
        if (
          node.querySelector(
            '.img, .message-img, img.msg-img, ' +
            '.msg_thumb, .msg-image, .msg_image, ' +
            '[class*="msg_img"], [class*="msgImg"], [class*="MsgImage"], ' +
            'img[class*="thumb"], img[class*="preview"], picture'
          )
        ) {
          return 'image';
        }

        // ── Audio / Voice ────────────────────────────────────────
        // Voice notes render as a play-button element, often with class
        // "voice_msg", "J_VoiceBtn", or contain an audio/waveform icon.
        if (
          node.querySelector(
            '[class*="voice"], [class*="Voice"], ' +
            '[class*="audio"], [class*="Audio"], ' +
            '.J_VoiceBtn, [class*="voiceMsg"], [class*="voice_msg"], ' +
            'audio'
          ) ||
          // Icon-font glyph fallback — WeChat uses icon classes for voice icons
          node.querySelector('[class*="icon_voice"], [class*="icon-voice"]')
        ) {
          return 'audio';
        }

        // ── Video ────────────────────────────────────────────────
        if (
          node.querySelector(
            '[class*="video"], [class*="Video"], ' +
            '[class*="msg_video"], [class*="msgVideo"], ' +
            'video, [class*="play_btn"], [class*="playBtn"]'
          )
        ) {
          return 'video';
        }

        // ── File / Document ──────────────────────────────────────
        // File messages show a document icon and a filename.
        if (
          node.querySelector(
            '[class*="file"], [class*="File"], ' +
            '[class*="attach"], [class*="Attach"], ' +
            '[class*="doc_icon"], [class*="docIcon"], ' +
            '[class*="msg_file"], [class*="msgFile"]'
          )
        ) {
          return 'file';
        }

        // ── Unknown media  ───────────────────────────────────────
        // Catch-all: if there's no plain text node but the bubble has child
        // elements that look like media placeholders, flag as unknown.
        const textContent = (
          node.querySelector(
            '.msg-content, .bubble, .message-content, .msg-content span'
          ) || node
        ).textContent?.trim();

        if (!textContent && node.children.length > 0) {
          return 'unknown';
        }

        return 'text';
      }

      /**
       * Build a short human-readable summary of the media in a bubble node.
       * Used to populate media_summary for the Decision Engine prompt.
       *
       * @param {HTMLElement} node       The message bubble element
       * @param {string}      mediaType  Output of _wcResolveMediaType(node)
       * @returns {string|null}
       */
      function _wcBuildMediaSummary(node, mediaType) {
        if (mediaType === 'text') return null;

        const parts = [];

        try {
          switch (mediaType) {
            case 'image': {
              // Caption text if present under the image
              const caption =
                node.querySelector('.img_caption, .msg-caption, [class*="caption"]')
                    ?.textContent?.trim();
              if (caption) parts.push(`caption: "${caption.slice(0, 60)}"`);

              // Alt text from the <img> element
              const img = node.querySelector('img');
              const alt = img?.alt?.trim();
              if (alt && alt !== 'image') parts.push(alt.slice(0, 40));
              break;
            }

            case 'audio': {
              // Voice-note duration is sometimes rendered as a text node
              // inside the voice bubble (e.g. "0:08")
              const durationEl = node.querySelector(
                '[class*="duration"], [class*="Duration"], ' +
                '[class*="voice_time"], [class*="voiceTime"]'
              );
              const duration = durationEl?.textContent?.trim();
              if (duration) parts.push(`duration: ${duration}`);
              break;
            }

            case 'video': {
              // Video duration / thumbnail label
              const durationEl = node.querySelector(
                '[class*="duration"], [class*="Duration"], ' +
                '[class*="video_time"], [class*="videoTime"]'
              );
              const duration = durationEl?.textContent?.trim();
              if (duration) parts.push(`duration: ${duration}`);
              break;
            }

            case 'file': {
              // File name is usually rendered in a dedicated element
              const nameEl = node.querySelector(
                '[class*="file_name"], [class*="fileName"], ' +
                '[class*="attach_name"], [class*="attachName"], ' +
                '.file-name, .filename'
              );
              const fileName = nameEl?.textContent?.trim();
              if (fileName) parts.push(`"${fileName.slice(0, 60)}"`);

              // File size
              const sizeEl = node.querySelector(
                '[class*="file_size"], [class*="fileSize"], ' +
                '[class*="attach_size"], [class*="attachSize"]'
              );
              const fileSize = sizeEl?.textContent?.trim();
              if (fileSize) parts.push(`(${fileSize})`);
              break;
            }

            case 'sticker':
              // Sticker alt text occasionally describes the emoji mood
              parts.push('sticker');
              break;

            default:
              break;
          }
        } catch {
          // DOM access failures are non-fatal — return whatever we built so far
        }

        return parts.length ? parts.join(' · ') : null;
      }

      // ── Deduplication key ──────────────────────────────────────────────────

      function msgKey(node) {
        return (
          node.getAttribute('data-msg-id') ||
          node.getAttribute('id') ||
          ((node.querySelector?.('.msg-content, .message-content, .bubble') || node)
            .textContent || '').slice(0, 60)
        );
      }

      // ── Core message extractor ─────────────────────────────────────────────

      function extractMessage(node) {
        // WeChat Web message bubbles sit inside a wrapping <li> or <div>.
        // Outgoing messages carry class "send" or an equivalent; incoming carry
        // "recv" or "receive". Bail out on outgoing so we never ingest our own sends.
        const classList = node.className || '';
        const isOutgoing = /\bsend\b|\bsent\b|\bown\b|\bright\b/.test(classList);
        if (isOutgoing) return null;

        // ── Media detection ────────────────────────────────────────────────
        const mediaType    = _wcResolveMediaType(node);
        const mediaSummary = _wcBuildMediaSummary(node, mediaType);

        // ── Text body ──────────────────────────────────────────────────────
        // For text messages the body lives in .msg-content span, .bubble, etc.
        // For media-only messages (image/sticker/voice with no caption) we fall
        // back to a bracketed type label so the base-agent guard clause does not
        // silently discard the message.
        const textEl =
          node.querySelector('.msg-content span, .bubble span, .message-content span, .msg-wrap span') ||
          node.querySelector('.msg-content, .bubble, .message-content');
        const textBody = textEl?.textContent?.trim() || '';

        const body = textBody || (mediaType !== 'text' ? `[${mediaType}]` : null);
        if (!body) return null;   // truly empty node — skip

        // ── Sender identification ──────────────────────────────────────────
        const nameEl =
          node.closest('.message-item, .msg-item, li')
              ?.querySelector('.msg-username, .from-name, .nickname') ||
          document.querySelector(
            '.web_wechat_tab_cut .info .nickname, .chatting .info .nickname'
          );
        const displayName = nameEl?.textContent?.trim() || 'WeChat Contact';

        // Contact ID: use the active chat's data-id or a hashed name fallback.
        const activeChat = document.querySelector(
          '.chat_item.on, .chat-item.active, [class*="chat_item"].on'
        );
        const contactId = activeChat?.getAttribute('data-id') ||
          `wc_${displayName.replace(/\s+/g, '_')}`;

        return {
          from:         `wc_${contactId}`,
          displayName,
          body,
          media_type:    mediaType,
          media_summary: mediaSummary,
        };
      }

      // ── MutationObserver ───────────────────────────────────────────────────

      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;

            const candidates = [
              ...(node.matches?.('.message-item, .msg-item, [class*="msg_item"], li[id^="msg"]') ? [node] : []),
              ...Array.from(node.querySelectorAll?.('.message-item, .msg-item, [class*="msg_item"], li[id^="msg"]') || []),
            ];

            for (const el of candidates) {
              const key = msgKey(el);
              if (seen.has(key)) continue;
              seen.add(key);

              const msg = extractMessage(el);
              if (!msg) continue;

              window.__rosOnMessage({ ...msg, timestamp: new Date().toISOString() });
            }
          }
        }
      });

      const installObserver = () => {
        const container =
          document.querySelector('#chatArea .message-panel, #chatArea .msg-wrap, .message-area, #chatArea') ||
          document.body;
        observer.observe(container, { childList: true, subtree: true });
        console.log('[ReplyWise] WeChat message observer installed on', container.id || container.className || 'body');
      };

      installObserver();
      // Re-install whenever the user switches chats (container may be rebuilt).
      setInterval(installObserver, 6000);
    });

    this.log('Message watcher installed (DOM MutationObserver)');
  }

  // ── Incoming message handler (overrides BaseAgent) ────────
  //
  // Extends the base implementation to forward media_type and media_summary
  // to the /api/ingest/wechat endpoint, matching the WhatsApp / Telegram
  // ingest payload shape expected by the Decision Engine.

  async onIncomingMessage({ from, displayName, body, media_type, media_summary, timestamp }) {
    // Guard: drop truly empty payloads (media-only messages arrive with a
    // "[type]" fallback body set in extractMessage, so this only catches
    // edge cases where the browser sends a completely empty object).
    const safeBody = String(body || '').trim();
    if (!safeBody) return;

    // Normalise on the Node.js side using the module-level helpers.
    const resolvedType    = resolveWeChatMediaType({ media_type });
    const resolvedSummary = buildWeChatMediaSummary({ media_type, media_summary }, resolvedType);

    const logLabel = resolvedType !== 'text'
      ? `[${resolvedType}${resolvedSummary ? ` · ${resolvedSummary.slice(0, 40)}` : ''}]`
      : safeBody.slice(0, 80);

    this.log(`← [${displayName || from}] ${logLabel}`);

    try {
      await axios.post(
        `${this.orchestratorUrl}/api/ingest/wechat`,
        {
          from:              String(from).trim(),
          externalContactId: String(from).trim(),
          displayName:       displayName || from,
          body:              safeBody,
          timestamp:         timestamp || new Date().toISOString(),
          media_type:        resolvedType,
          media_summary:     resolvedSummary,
        },
        { timeout: 15000 }
      );
    } catch (err) {
      this.log(`Failed to POST incoming to orchestrator: ${err.message}`);
    }
  }

  // ── Send message ──────────────────────────────────────────

  async sendMessageViaUI(page, { externalContactId, displayName, body }) {
    const searchName = displayName || externalContactId.replace(/^wc_/, '');

    this.log(`Searching for WeChat contact: ${searchName}`);

    const searchBtn = await page.$(
      '[ng-click*="search"], .search-icon, #search_bar input, .new_chat_btn, [title="New Chat"]'
    );
    if (searchBtn) {
      await searchBtn.click();
      await this.randomDelay(400, 800);
    }

    const searchInput = await page.$(
      '#search_bar input, .search-box input, input[placeholder*="Search"], input[placeholder*="search"]'
    );
    if (!searchInput) {
      throw new Error('WeChat: Could not find search input');
    }

    await searchInput.click();
    await this.randomDelay(200, 400);
    await searchInput.fill('');
    await this.humanTypeIntoFocused(page, searchName);
    await this.randomDelay(1000, 2000);

    const firstResult = await page.$(
      '.contact_item:first-child, .search-result-item:first-child, [class*="contact_item"]:first-child'
    );
    if (firstResult) {
      await firstResult.click();
    } else {
      await page.keyboard.press('Enter');
    }
    await this.randomDelay(600, 1200);

    const inputBox = await page.$(
      '#editArea, .chat-input-area [contenteditable], .input-area [contenteditable], textarea.chat-input'
    );
    if (!inputBox) {
      throw new Error('WeChat: Could not find message input');
    }

    await inputBox.click();
    await this.randomDelay(200, 500);

    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');

    await this.humanTypeIntoFocused(page, body);
    await this.randomDelay(300, 800);

    // WeChat Web sends on Enter (Shift+Enter = newline)
    await page.keyboard.press('Enter');
    this.log(`Message sent to ${searchName}`);
    await this.randomDelay(500, 1000);
  }
}

// ── Standalone launch ─────────────────────────────────────────
if (require.main === module) {
  require('dotenv').config();
  const agent = new WeChatAgent();
  agent.start().catch((err) => {
    console.error('WeChat agent failed:', err);
    process.exit(1);
  });
  process.on('SIGINT',  () => agent.stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => agent.stop().then(() => process.exit(0)));
}

module.exports = WeChatAgent;
