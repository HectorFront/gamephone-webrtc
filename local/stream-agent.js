const { RTCPeerConnection, RTCVideoSource, rgbaFrameToI420 } = require('@roamhq/wrtc').nonstandard;
const { RTCSessionDescription, RTCIceCandidate } = require('@roamhq/wrtc');
const WebSocket = require('ws');
const { spawn } = require('child_process');

const SIGNAL_URL  = 'wss://game.mexpenses.com.br/ws';
const STREAM_ID   = 'stream-agent';
const VIEWER_ID   = 'viewer-1';

const WIDTH      = 2560;
const HEIGHT     = 1440;
const FPS        = 30;
const FRAME_SIZE = WIDTH * HEIGHT * 4; // RGBA

// ── Video source WebRTC ────────────────────────────────────────────────────
const source = new RTCVideoSource();
const track  = source.createTrack();

let ffmpeg = null;
let buf    = Buffer.alloc(0);

function startFFmpeg() {
  if (ffmpeg) return;
  console.log('[Stream] Iniciando ffmpeg...');

  ffmpeg = spawn('ffmpeg', [
    '-f', 'gdigrab',
    '-framerate', String(FPS),
    '-i', 'desktop',
    '-vf', `scale=${WIDTH}:${HEIGHT}`,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });

  ffmpeg.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= FRAME_SIZE) {
      const frame = buf.slice(0, FRAME_SIZE);
      buf = buf.slice(FRAME_SIZE);

      const i420 = { width: WIDTH, height: HEIGHT,
        data: new Uint8ClampedArray(frame) };
      try { source.onFrame(i420); } catch {}
    }
  });

  ffmpeg.on('close', (code) => {
    console.log(`[Stream] ffmpeg encerrou (${code})`);
    ffmpeg = null;
  });
}

function stopFFmpeg() {
  if (ffmpeg) { ffmpeg.kill('SIGKILL'); ffmpeg = null; }
}

// ── WebRTC + Signaling ─────────────────────────────────────────────────────
let pc  = null;
let ws  = null;
let viewerId = null;
let _pendingIce = [];

function openWS() {
  ws = new WebSocket(SIGNAL_URL);

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'register', role: 'agent-stream', id: STREAM_ID }));
    console.log('[Signal] Registrado como', STREAM_ID);
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    console.log('[Signal] msg:', msg.type, 'from:', msg.from);

    if (msg.type === 'offer') {
      viewerId = msg.from;
      _pendingIce = [];
      if (pc) { try { pc.close(); } catch {} pc = null; }

      pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      pc.addTrack(track);

      pc.onicecandidate = ({ candidate }) => {
        if (candidate && ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: 'ice', to: viewerId, candidate }));
      };

      pc.onconnectionstatechange = () => {
        console.log('[WebRTC] State:', pc.connectionState);
        if (pc.connectionState === 'connected') startFFmpeg();
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          stopFFmpeg();
          try { pc.close(); } catch {} pc = null;
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
      _pendingIce.forEach(c => { try { pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} });
      _pendingIce = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', to: viewerId, sdp: answer.sdp }));
    }

    if (msg.type === 'ice') {
      const c = msg.candidate;
      if (pc) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} }
      else _pendingIce.push(c);
    }
  });

  ws.on('close', () => {
    console.log('[Signal] Desconectado, reconectando...');
    stopFFmpeg();
    setTimeout(openWS, 3000);
  });
  ws.on('error', (e) => console.error('[Signal] Erro:', e.message));
}

openWS();
