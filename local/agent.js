const nodedc = require('node-datachannel');
const WebSocket = require('ws');
const { Worker } = require('worker_threads');
const path = require('path');

const SIGNAL_URL = 'wss://game.mexpenses.com.br/ws';
const AGENT_ID   = 'agent-windows';

const worker = new Worker(path.join(__dirname, 'input-worker.js'));
worker.on('error', e => console.error('[worker error]', e.message));

worker.postMessage({ action: 'init', w: 2560, h: 1440 });
console.log('[Screen] usando resolução padrão 2560x1440 - ajuste em agent.js se necessário');

const _queue = [];
let _busy = false;

function enqueue(cmd) {
  if (cmd.action === 'mousemove' || cmd.action === 'scroll') {
    worker.postMessage(cmd);
    return;
  }
  _queue.push(cmd);
  if (!_busy) drain();
}

function drain() {
  if (_busy || _queue.length === 0) return;
  _busy = true;
  const cmd = _queue.shift();
  worker.postMessage(cmd);
  setImmediate(() => { _busy = false; drain(); });
}

const _warmup = new nodedc.PeerConnection('warmup', { iceServers: [] });
setTimeout(() => { try { _warmup.close(); } catch {} }, 2000);

const ws = new WebSocket(SIGNAL_URL);
let peer = null;
let controllerId = null;
let _pendingIce = [];

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'register', role: 'agent', id: AGENT_ID }));
  console.log('[Signal] Registrado como', AGENT_ID);
});

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  console.log('[Signal] msg:', msg.type, 'from:', msg.from);

  if (msg.type === 'offer') {
    controllerId = msg.from;
    _queue.length = 0;
    _pendingIce = [];
    worker.postMessage({ action: 'reset' });
    if (peer) { try { peer.close(); } catch {} peer = null; }

    setTimeout(() => {
      console.log('[WebRTC] Criando peer...');
      peer = new nodedc.PeerConnection('agent-' + Date.now(), {
        iceServers: ['stun:stun.l.google.com:19302'],
      });

      peer.onLocalDescription((sdp, type) => {
        console.log('[WebRTC] Enviando', type);
        ws.send(JSON.stringify({ type, to: controllerId, sdp }));
      });

      peer.onLocalCandidate((candidate, mid) => {
        ws.send(JSON.stringify({ type: 'ice', to: controllerId, candidate, mid }));
      });

      peer.onStateChange((state) => {
        console.log('[WebRTC] State:', state);
        if (state === 'failed' || state === 'closed') {
          try { peer.close(); } catch {}
          peer = null;
        }
      });

      peer.onDataChannel((dc) => {
        console.log('[DataChannel] aberto:', dc.getLabel());
        dc.onMessage((data) => {
          try {
            const cmd = JSON.parse(data);
            if (cmd.action === 'ping') {
              dc.sendMessage(JSON.stringify({ action: 'pong', t: cmd.t }));
              return;
            }
            enqueue(cmd);
          } catch(e) { console.error('[CMD]', e.message); }
        });
        dc.onClosed(() => console.log('[DataChannel] fechado'));
        dc.onError((e) => console.log('[DataChannel] erro:', e));
      });

      peer.setRemoteDescription(msg.sdp, 'offer');
      _pendingIce.forEach(ic => {
        try { peer.addRemoteCandidate(ic.cand, ic.mid); } catch(e) { console.error('[ICE pending]', e.message); }
      });
      _pendingIce = [];
    }, 100);
  }

  if (msg.type === 'ice') {
    try {
      const cand = typeof msg.candidate === 'object' && msg.candidate?.candidate
        ? msg.candidate.candidate : msg.candidate;
      const mid = msg.candidate?.sdpMid ?? msg.mid ?? '0';
      if (peer) peer.addRemoteCandidate(cand, mid);
      else _pendingIce.push({ cand, mid });
    } catch(e) { console.error('[ICE]', e.message); }
  }
});

ws.on('close', () => console.log('[Signal] Desconectado'));
ws.on('error', (e) => console.error('[Signal] Erro:', e.message));
