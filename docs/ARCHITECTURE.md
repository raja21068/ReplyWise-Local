# Architecture

```txt
Browser Agent
  - WhatsApp: whatsapp-web.js
  - Telegram: Playwright persistent session
      ↓
/api/ingest/:channel
      ↓
Local JSON store
      ↓
Decision Engine
      ↓
Reply Generator
      ↓
Smart Autopilot
      ↓
Dashboard or auto-send queue
      ↓
/api/bridge/pending-outgoing
      ↓
Browser Agent sends through UI
```

## Smart Autopilot

Implemented in `src/brain/autopilot-engine.js`.

It returns:

```json
{
  "mode": "auto_choose",
  "recommended_text": "...",
  "auto_send": {
    "allowed": false,
    "blocked_reasons": []
  }
}
```

The server stores this in each suggestion and queues an outgoing message only if auto-send is explicitly enabled and all safety checks pass.
