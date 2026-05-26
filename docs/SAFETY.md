# Safety Model

ReplyWise Local is human-first. Automation is intentionally limited.

## Automation levels

1. **Manual** — user chooses and sends.
2. **Auto-Choose** — system recommends one option, user still sends.
3. **Safe Auto-Send** — system sends only simple, low-risk replies for whitelisted contacts.

## Auto-send blocks

Auto-send is blocked for:

- emotional messages
- conflict
- boundaries or rejection
- flirting/date planning
- open questions, unless explicitly allowed
- low confidence
- over-investing/double-text risk
- unsafe text
- non-whitelisted contacts when whitelist mode is on

## Recommended defaults

```env
AUTO_CHOOSE_ENABLED=true
AUTO_SEND_ENABLED=false
AUTO_SEND_WHITELIST_ONLY=true
AUTO_SEND_CONFIDENCE_MIN=97
AUTO_SEND_MAX_LENGTH=80
AUTO_SEND_ALLOW_OPEN_QUESTIONS=false
AUTO_SEND_ALLOW_EMOTIONAL=false
```
