# Architecture — ReplyWise v4

```
Browser Agents (separate processes)
  ├── WhatsApp  → whatsapp-web.js (Puppeteer)   ← NEW: media metadata + optional download
  ├── Telegram  → Playwright (persistent session)
  └── WeChat    → Playwright (web.wechat.com QR) ← NEW in v4
         ↓
/api/ingest/:channel  (POST with media_type, media_summary)
         ↓
Decision Engine v2
  ├── Signal detection (boundary, conflict, emotional, low-effort)
  ├── Media routing  (image/audio/video/file/sticker/unknown)  ← NEW
  ├── Media risk score (low/medium/high)                       ← NEW
  └── context_summary  (one-line human-readable summary)       ← NEW
         ↓
AI Provider Router
  ├── local   (zero-cost rule engine, default)
  ├── ollama  (local LLM, OLLAMA_BASE_URL)
  └── claude  (Anthropic API, ANTHROPIC_API_KEY)              ← NEW
         ↓
Smart Autopilot Engine
  └── graduated modes: manual → auto_choose → auto_send_safe
         ↓
Dashboard (human approves / waits / skips)
         ↓
/api/bridge/pending-outgoing
         ↓
Browser Agent sends via UI automation
```

## Environment Variables (new in v4)

| Variable | Default | Description |
|---|---|---|
| `ENABLED_AGENTS` | `whatsapp,telegram` | Comma-separated: `whatsapp,telegram,wechat` |
| `AI_PROVIDER` | `local` | `local`, `ollama`, or `claude` |
| `ANTHROPIC_API_KEY` | — | Required when `AI_PROVIDER=claude` |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` | Claude model string |
| `CLAUDE_FORCE` | `false` | Skip local shortcut even on WAIT/NO decisions |
| `WHATSAPP_DOWNLOAD_MEDIA` | `false` | Download media files to `./data/media/whatsapp` |
| `MEDIA_DIR` | `./data/media` | Root directory for downloaded media |
| `AGENT_MAX_RESTARTS` | `8` | Max consecutive agent restart attempts |

## Smart Autopilot modes

- **manual** — suggestions shown, human chooses every send.
- **auto_choose** — best option is pre-selected, human clicks send once.
- **auto_send_safe** — auto-sends only low-risk greetings/acks from whitelisted contacts.

## Decision Engine outputs (v2 additions)

```json
{
  "action": "yes|wait|no|repair|review",
  "media_type": "text|image|audio|video|file|sticker|unknown",
  "media_risk": "low|medium|high",
  "context_summary": "Contact: sent an image. Safe to reply.",
  "risk_level": "low|medium|high",
  ...existing fields
}
```
