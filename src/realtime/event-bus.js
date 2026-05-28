/**
 * Realtime Event Bus + SSE adapter
 *
 * Replaces the dashboard's `setTimeout(reload, 20000)` with Server-Sent Events.
 * Any module can emit a typed event; subscribed browsers receive it within
 * milliseconds via an `EventSource` connection.
 *
 * Why SSE and not WebSocket
 * ─────────────────────────
 *   • Built into every browser, zero deps on either side.
 *   • One-way (server → client) is exactly what the dashboard needs.
 *   • Works through corporate proxies and load balancers transparently.
 *   • Auto-reconnects with the standard browser implementation.
 *
 * Event types currently emitted:
 *   suggestion.created    — new suggestion ready for review
 *   suggestion.approved   — user picked an option / sent custom reply
 *   suggestion.skipped    — user skipped or marked as wait
 *   agent.status          — bridge agent status changed
 *   schedule.tick         — scheduler fired a deferred message
 *   contact.updated       — contact profile / rules changed
 *
 * Usage from any module:
 *   const bus = require('./realtime/event-bus');
 *   bus.emit('suggestion.created', { suggestionId, contactId, displayName });
 *
 * Usage from server.js:
 *   app.get('/api/events/stream', bus.sseHandler());
 */

'use strict';

const EventEmitter = require('events');

// ── Singleton bus ─────────────────────────────────────────────

class ReplyWiseEventBus extends EventEmitter {
  constructor() {
    super();
    // Higher cap — the dashboard subscribes to many event names from one socket
    this.setMaxListeners(50);
    this._clients = new Set();
  }

  /**
   * Emit a typed event to all internal listeners AND broadcast to every
   * connected SSE client.
   */
  emit(eventName, payload = {}) {
    super.emit(eventName, payload);
    super.emit('*', { eventName, payload });
    this._broadcast(eventName, payload);
    return true;
  }

  _broadcast(eventName, payload) {
    const line = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of this._clients) {
      try {
        res.write(line);
      } catch {
        // Client disconnected mid-write — will be cleaned up on next ping
        this._clients.delete(res);
      }
    }
  }

  /**
   * Returns an Express handler that opens a long-lived SSE connection.
   *
   * The handler:
   *   • Sends a hello frame so the client confirms connection
   *   • Sends a comment ping every 25 s to defeat proxy timeouts
   *   • Cleans up the client on disconnect / error
   */
  sseHandler() {
    return (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',  // disables nginx buffering if behind one
      });

      // Hello frame — confirms wiring
      res.write(`event: hello\ndata: ${JSON.stringify({
        connectedAt: new Date().toISOString(),
        clientCount: this._clients.size + 1,
      })}\n\n`);

      this._clients.add(res);

      // Keep-alive ping every 25 s (comment line — ignored by EventSource)
      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); }
        catch { /* dead */ }
      }, 25_000);

      const cleanup = () => {
        clearInterval(ping);
        this._clients.delete(res);
      };
      req.on('close', cleanup);
      req.on('error', cleanup);
      res.on('error', cleanup);
    };
  }

  stats() {
    return {
      connectedClients: this._clients.size,
      maxListeners: this.getMaxListeners(),
    };
  }
}

// Export a process-wide singleton — every require returns the same instance
module.exports = new ReplyWiseEventBus();
