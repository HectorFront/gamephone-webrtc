const { RTCPeerConnection } = require('@roamhq/wrtc');
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

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

const ws = new WebSocket(SIGNAL_URL);
let pc = null;
let controllerId = null;
let _pendingIce = [];

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'register', role: 'agent', id: AGENT_ID }));
  console.log('[Signal] Registrado como', AGENT_ID);
});

ws.on('message', async (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  console.log('[Signal] msg:', msg.type, 'from:', msg.from);

  if (msg.type === 'offer') {
    controllerId = msg.from;
    _queue.length = 0;
    _pendingIce = [];
    worker.postMessage({ action: 'reset' });
    if (pc) { try { pc.close(); } catch {} pc = null; }

    console.log('[WebRTC] Criando peer...');
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = ({ candidate }) => {
      if (candidate && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'ice', to: controllerId, candidate }));
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[ICE]', pc.iceConnectionState);
    };

    pc.onconnectionstatechange = () => {
      console.log('[WebRTC] State:', pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        try { pc.close(); } catch {}
        pc = null;
      }
    };

    pc.ondatachannel = ({ channel: dc }) => {
      console.log('[DataChannel] aberto:', dc.label);
      dc.onmessage = ({ data }) => {
        try {
          const cmd = JSON.parse(data);
          if (cmd.action === 'ping') {
            dc.send(JSON.stringify({ action: 'pong', t: cmd.t }));
            return;
          }
          enqueue(cmd);
        } catch(e) { console.error('[CMD]', e.message); }
      };
      dc.onclose = () => console.log('[DataChannel] fechado');
      dc.onerror = (e) => console.log('[DataChannel] erro:', e);
    };

    await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
    _pendingIce.forEach(c => { try { pc.addIceCandidate(c); } catch {} });
    _pendingIce = [];

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: 'answer', to: controllerId, sdp: answer.sdp }));
  }

  if (msg.type === 'ice') {
    const candidate = typeof msg.candidate === 'object' ? msg.candidate : { candidate: msg.candidate, sdpMid: msg.mid ?? '0' };
    if (pc) { try { await pc.addIceCandidate(candidate); } catch(e) { console.error('[ICE]', e.message); } }
    else _pendingIce.push(candidate);
  }
});

ws.on('close', () => console.log('[Signal] Desconectado'));
ws.on('error', (e) => console.error('[Signal] Erro:', e.message));
