# Safety Rules

1. No autonomous sending.
2. Manual approval is required for every outgoing message.
3. Boundary messages switch the product into `no` or `repair` mode.
4. System instruction options like `[Do not reply]` cannot be sent as messages.
5. The assistant should recommend waiting when the user is over-investing.
6. Do not build stealth, ban-evasion, or anti-detection features.
7. Screenshots are debug-only and off by default.
8. Store private chats locally and allow deletion by removing `data/conversationos.store.json`.
