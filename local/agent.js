/**
 * agent.js
 *
 * WebRTC input agent — runs on the Windows PC.
 *
 * Connects to the signaling server, waits for an offer from the mobile
 * controller, and forwards all received input commands (mouse, keyboard)
 * to the input-worker thread via nut-js / SendInput.
 *
 * Flow:
 *   1. Spawn input-worker thread and initialise screen resolution.
 *   2. Connect to the signaling server (WebSocket).
 *   3. On incoming offer, create a RTCPeerConnection and open a DataChannel.
 *   4. Relay DataChannel messages to the worker queue.
 */

const { RTCPeerConnection } = require('@roamhq/wrtc');
const WebSocket = require('ws');
const { Worker } = require('worker_threads');
const path = require('path');

// ── Configuration ──────────────────────────────────────────────────────────

const SIGNAL_URL = 'wss://game.mexpenses.com.br/ws';
const AGENT_ID   = 'agent-windows';

// ── Input worker ───────────────────────────────────────────────────────────
// Runs nut-js in a dedicated thread to avoid blocking the event loop.

const worker = new Worker(path.join(__dirname, 'input-worker.js'));
worker.on('error', e => console.error('[worker error]', e.message));

worker.postMessage({ action: 'init', w: 1920, h: 720 });
console.log('[Screen] Using default resolution 1920x720 — adjust in agent.js if needed');

// ── Command queue ──────────────────────────────────────────────────────────
// High-frequency events (mousemove, scroll) bypass the queue and are sent
// directly to the worker to minimise latency. All other commands are
// serialised to prevent race conditions in nut-js.

const _queue = [];
let _busy = false;

/**
 * Routes a command to the worker.
 * mousemove and scroll are fire-and-forget; everything else is queued.
 *
 * @param {{ action: string }} cmd - Input command object.
 */
function enqueue(cmd) {
  if (cmd.action === 'mousemove' || cmd.action === 'scroll') {
    worker.postMessage(cmd);
    return;
  }
  _queue.push(cmd);
  if (!_busy) drain();
}

/**
 * Processes the next command in the queue.
 * Uses setImmediate to yield between commands and keep the event loop responsive.
 */
function drain() {
  if (_busy || _queue.length === 0) return;
  _busy = true;
  const cmd = _queue.shift();
  worker.postMessage(cmd);
  setImmediate(() => { _busy = false; drain(); });
}

// ── WebRTC ─────────────────────────────────────────────────────────────────

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// ── Signaling ──────────────────────────────────────────────────────────────

const ws = new WebSocket(SIGNAL_URL);
let pc           = null;
let controllerId = null;
let _pendingIce  = []; // ICE candidates received before remote description is set

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'register', role: 'agent', id: AGENT_ID }));
  console.log('[Signal] Registered as', AGENT_ID);
});

ws.on('message', async (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  console.log('[Signal] msg:', msg.type, 'from:', msg.from);

  // ── Handle SDP offer from the controller ──────────────────────────────
  if (msg.type === 'offer') {
    controllerId = msg.from;
    _queue.length = 0; // discard stale commands from a previous session
    _pendingIce   = [];
    worker.postMessage({ action: 'reset' });

    if (pc) { try { pc.close(); } catch {} pc = null; }

    console.log('[WebRTC] Creating peer connection...');
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Forward local ICE candidates to the controller via signaling.
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

    // ── DataChannel — receives input commands from the controller ────────
    pc.ondatachannel = ({ channel: dc }) => {
      console.log('[DataChannel] Opened:', dc.label);

      dc.onmessage = ({ data }) => {
        try {
          const cmd = JSON.parse(data);
          // Respond to ping immediately to allow RTT measurement on the controller.
          if (cmd.action === 'ping') {
            dc.send(JSON.stringify({ action: 'pong', t: cmd.t }));
            return;
          }
          enqueue(cmd);
        } catch(e) { console.error('[CMD]', e.message); }
      };

      dc.onclose = () => console.log('[DataChannel] Closed');
      dc.onerror = (e) => console.log('[DataChannel] Error:', e);
    };

    await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });

    // Apply any ICE candidates that arrived before the remote description.
    _pendingIce.forEach(c => { try { pc.addIceCandidate(c); } catch {} });
    _pendingIce = [];

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: 'answer', to: controllerId, sdp: answer.sdp }));
  }

  // ── Handle incoming ICE candidate from the controller ─────────────────
  if (msg.type === 'ice') {
    const candidate = typeof msg.candidate === 'object'
      ? msg.candidate
      : { candidate: msg.candidate, sdpMid: msg.mid ?? '0' };

    if (pc) { try { await pc.addIceCandidate(candidate); } catch(e) { console.error('[ICE]', e.message); } }
    else _pendingIce.push(candidate);
  }
});

ws.on('close', () => console.log('[Signal] Disconnected'));
ws.on('error', (e) => console.error('[Signal] Error:', e.message));
