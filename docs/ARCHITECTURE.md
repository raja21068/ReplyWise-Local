# Architecture

```text
WhatsApp Web / Telegram Web
        ↓
Browser Agent
        ↓ POST /api/ingest/:channel
Orchestrator
        ↓
Local judgment engine + reply engine
        ↓
Mobile-first dashboard card
        ↓ manual approval
Outgoing queue
        ↓ polling
Browser Agent types/sends via UI
```

## Key folders

```text
src/server.js                  Express orchestrator + dashboard
src/brain/decision-engine.js   Should-you-reply judgment
src/brain/stats-engine.js      Free local conversation stats
src/ai/local-rule-engine.js    Free reply options
src/bridge/whatsapp-agent.js   whatsapp-web.js browser agent
src/bridge/telegram-agent.js   Playwright Telegram Web agent
src/bridge/agent-manager.js    Starts and monitors enabled agents
src/db/index.js                Local JSON store
```

## Cost design

Normal read path avoids screenshots and OCR. It relies on event/DOM/WebSocket text extraction.

## Reliability design

The agent manager restarts crashed agents with backoff. Re-auth page explains how to log in without screenshots by using a visible browser.
