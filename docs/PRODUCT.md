# Product Design

## Killer promise

> It does not just write replies. It tells you whether replying is a good idea.

## MVP user loop

1. Message arrives from WhatsApp or Telegram.
2. Browser agent posts text to `/api/ingest/:channel`.
3. Local judgment engine analyzes context, energy, warmth, boundary risk, and timing.
4. Dashboard shows a decision card.
5. User chooses Send, Edit, Wait, or Skip.
6. Approved messages enter outgoing queue.
7. Browser agent sends through the actual web session.

## Why only WhatsApp + Telegram

- WhatsApp is the original high-value channel.
- Telegram is the best second browser-agent channel.
- More channels increase RAM, fragility, and debugging cost.

## Decision engine outputs

```json
{
  "should_reply": "yes | wait | no | repair | end",
  "action": "yes | wait | no | repair | end",
  "confidence": 87,
  "reason": "They asked an open question.",
  "best_move": "Answer lightly and ask back.",
  "avoid": "Do not over-flirt or write an essay.",
  "wait_minutes": 0,
  "temperature": "warm",
  "risk_level": "low"
}
```

## Local stats

- Your average message length
- Their average message length
- Energy ratio
- Double-text risk
- Warmth score
- Language style
- Emoji count
- Question rate

These stats are free to compute and make the product feel smart without paid AI.
