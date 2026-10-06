/**
 * signaling-server.js
 *
 * WebSocket signaling server — runs on the Ubuntu VPS (port 8080).
 *
 * Responsibilities:
 *   - Register clients by role (agent, agent-stream, controller, viewer).
 *   - Notify peers when their counterpart comes online (peer-ready).
 *   - Relay WebRTC SDP offers, answers, and ICE candidates between peers.
 *
 * Client roles:
 *   agent        — Windows input agent       (id: 'agent-windows')
 *   agent-stream — Windows stream agent      (id: 'stream-agent')
 *   controller   — Mobile gamepad page       (id: 'controller-1')
 *   viewer       — Browser stream viewer     (id: 'viewer-<random>')
 */

const { WebSocketServer } = require('ws');

const wss     = new WebSocketServer({ port: 8080 });
const clients = new Map(); // id → WebSocket

wss.on('connection', (ws) => {
  let clientId = null;

  // Keep-alive ping every 15 s to prevent proxy/firewall timeouts.
  const ping = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 15000);

  ws.on('pong', () => {}); // pong received — connection is alive

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Register ─────────────────────────────────────────────────────────
    if (msg.type === 'register') {
      // Replace any stale connection registered under the same id.
      if (clients.has(msg.id)) {
        const old = clients.get(msg.id);
        if (old !== ws) try { old.close(); } catch {}
      }

      clientId = msg.id;
      clients.set(clientId, ws);
      console.log(`[+] Registered: ${clientId} (${msg.role})`);
      ws.send(JSON.stringify({ type: 'registered', id: clientId }));

      // Notify the controller if its agent is already online.
      if (msg.role === 'agent' && clients.has('controller-1')) {
        clients.get('controller-1').send(JSON.stringify({ type: 'peer-ready', id: clientId }));
      }

      // Notify the controller that the agent is ready to receive an offer.
      if (msg.role === 'controller' && clients.has('agent-windows')) {
        ws.send(JSON.stringify({ type: 'peer-ready', id: 'agent-windows' }));
      }

      // Notify all waiting viewers that the stream agent is now online.
      if (msg.role === 'agent-stream') {
        for (const [id, client] of clients) {
          if (id.startsWith('viewer-')) {
            client.send(JSON.stringify({ type: 'peer-ready', id: clientId }));
          }
        }
      }

      // Notify the viewer that the stream agent is already online.
      if (msg.role === 'viewer' && clients.has('stream-agent')) {
        ws.send(JSON.stringify({ type: 'peer-ready', id: 'stream-agent' }));
      }

      return;
    }

    // ── Signaling keep-alive ping ─────────────────────────────────────────
    if (msg.type === 'ping-signal') {
      ws.send(JSON.stringify({ type: 'pong-signal' }));
      return;
    }

    // ── Relay — forward any message with a 'to' field to the target client ─
    if (msg.to) {
      console.log(`[relay] ${clientId} -> ${msg.to} (${msg.type})`);
      if (clients.has(msg.to)) {
        clients.get(msg.to).send(JSON.stringify({ ...msg, from: clientId }));
      }
    }
  });

  ws.on('close', () => {
    clearInterval(ping);
    // Only remove the entry if this socket is still the registered one
    // (a reconnect may have already replaced it).
    if (clientId && clients.get(clientId) === ws) {
      clients.delete(clientId);
      console.log(`[-] Disconnected: ${clientId}`);
    }
  });
});

console.log('Signaling server running on ws://localhost:8080');
