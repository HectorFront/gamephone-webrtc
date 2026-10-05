const { WebSocketServer } = require("ws");

const wss = new WebSocketServer({ port: 8080 });
const clients = new Map(); // id -> ws

wss.on("connection", (ws) => {
  let clientId = null;

  const ping = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 15000);

  ws.on("pong", () => {});
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "register") {
      // remove registro antigo do mesmo id se existir
      if (clients.has(msg.id)) {
        const old = clients.get(msg.id);
        if (old !== ws) try { old.close(); } catch {}
      }
      clientId = msg.id;
      clients.set(clientId, ws);
      console.log(`[+] Registered: ${clientId} (${msg.role})`);
      ws.send(JSON.stringify({ type: "registered", id: clientId }));
      if (msg.role === 'agent' && clients.has('controller-1')) {
        clients.get('controller-1').send(JSON.stringify({ type: 'peer-ready', id: clientId }));
      }
      if (msg.role === 'controller' && clients.has('agent-windows')) {
        ws.send(JSON.stringify({ type: 'peer-ready', id: 'agent-windows' }));
      }
      if (msg.role === 'agent-stream') {
        // notifica todos os viewers que estão esperando
        for (const [id, client] of clients) {
          if (id.startsWith('viewer-')) {
            client.send(JSON.stringify({ type: 'peer-ready', id: clientId }));
          }
        }
      }
      if (msg.role === 'viewer' && clients.has('stream-agent')) {
        ws.send(JSON.stringify({ type: 'peer-ready', id: 'stream-agent' }));
      }
      return;
    }

    if (msg.type === 'ping-signal') {
      ws.send(JSON.stringify({ type: 'pong-signal' }));
      return;
    }

    if (msg.to) {
      console.log(`[relay] ${clientId} -> ${msg.to} (${msg.type})`);
      if (clients.has(msg.to)) {
        clients.get(msg.to).send(JSON.stringify({ ...msg, from: clientId }));
      }
    }
  });

  ws.on("close", () => {
    clearInterval(ping);
    if (clientId && clients.get(clientId) === ws) {
      clients.delete(clientId);
      console.log(`[-] Disconnected: ${clientId}`);
    }
  });
});

console.log("Signaling server running on ws://localhost:8080");
