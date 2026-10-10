const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, MediaStream } = require('wrtc');
const { RTCAudioSource } = require('wrtc').nonstandard;
const WebSocket = require('ws');
const { spawn } = require('child_process');

const SIGNAL_URL   = 'wss://game.mexpenses.com.br/ws';
const STREAM_ID    = 'stream-agent';
const AUDIO_DEVICE = 'CABLE Output (VB-Audio Virtual Cable)';

const WIDTH  = 1280;
const HEIGHT = 720;
const FPS    = 30;

// ── Audio WebRTC ─────────────────────────────────────────────────────────
const SAMPLE_RATE       = 44100;
const CHANNELS          = 2;
const SAMPLES_FRAME     = SAMPLE_RATE / 100;
const AUDIO_FRAME_BYTES = SAMPLES_FRAME * CHANNELS * 2;
const audioAB           = new ArrayBuffer(AUDIO_FRAME_BYTES);
const audioSamples      = new Int16Array(audioAB);
const audioRing         = Buffer.from(audioAB);
let   audioWritePos     = 0;

const audioSource = new RTCAudioSource();
const audioTrack  = audioSource.createTrack();
const audioStream = new MediaStream([audioTrack]);

let ffmpegVideo = null;
let ffmpegAudio = null;

// ── Viewers ────────────────────────────────────────────────────────────────
const viewers = new Map(); // viewerId -> { ws, pc, dcVideo }

function broadcastNAL(buf) {
  for (const [, v] of viewers) {
    if (v.dcVideo && v.dcVideo.readyState === 'open') {
      try { v.dcVideo.send(buf); } catch {}
    }
  }
}

// ── ffmpeg H264 ────────────────────────────────────────────────────────────
function startFFmpeg() {
  if (ffmpegVideo) return;
  console.log('[Stream] Starting ffmpeg H264...');

  ffmpegVideo = spawn('ffmpeg', [
    '-fflags',          'nobuffer+discardcorrupt',
    '-flags',           'low_delay',
    '-f',               'gdigrab',
    '-framerate',       String(FPS),
    '-probesize',       '32',
    '-analyzeduration', '0',
    '-i',               'desktop',
    '-vf',              `scale=${WIDTH}:${HEIGHT},fps=${FPS},format=yuv420p`,
    // H264 encode — ultrafast + zerolatency = minimum latency
    '-c:v',             'libx264',
    '-preset',          'ultrafast',
    '-tune',            'zerolatency',
    '-profile:v',       'baseline',
    '-level',           '3.1',
    '-x264-params',     'keyint=30:min-keyint=30:scenecut=0',
    '-bf',              '0',
    // Output Annex B (NAL units with start codes 0x00000001)
    '-f',               'h264',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  ffmpegVideo.stderr.on('data', (d) => {
    console.error('[ffmpeg]', d.toString().trim());
  });

  // Send raw H264 stream — browser handles parsing
  ffmpegVideo.stdout.on('data', (chunk) => broadcastNAL(chunk));

  ffmpegVideo.on('close', (code) => {
    console.log(`[Stream] ffmpeg H264 closed (${code})`);
    ffmpegVideo = null;
  });

  // ── Audio ─────────────────────────────────────────────────────────────────
  console.log('[Stream] Starting ffmpeg audio...');
  ffmpegAudio = spawn('ffmpeg', [
    '-fflags', 'nobuffer',
    '-f',      'dshow',
    '-i',      `audio=${AUDIO_DEVICE}`,
    '-f',      's16le',
    '-ar',     String(SAMPLE_RATE),
    '-ac',     String(CHANNELS),
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  ffmpegAudio.stderr.on('data', (d) => console.error('[ffmpeg-audio]', d.toString().trim()));

  audioWritePos = 0;
  ffmpegAudio.stdout.on('data', (raw) => {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    let src = 0;
    while (src < chunk.length) {
      const space = Math.min(chunk.length - src, AUDIO_FRAME_BYTES - audioWritePos);
      chunk.copy(audioRing, audioWritePos, src, src + space);
      audioWritePos += space;
      src += space;
      if (audioWritePos === AUDIO_FRAME_BYTES) {
        try {
          audioSource.onData({
            samples: audioSamples,
            sampleRate: SAMPLE_RATE,
            bitsPerSample: 16,
            channelCount: CHANNELS,
            numberOfFrames: SAMPLES_FRAME,
          });
        } catch(e) { console.error('[onAudio]', e.message); }
        audioWritePos = 0;
      }
    }
  });

  ffmpegAudio.on('close', (code) => {
    console.log(`[Stream] ffmpeg audio closed (${code})`);
    ffmpegAudio = null;
  });
}

function stopFFmpeg() {
  if (ffmpegVideo) { ffmpegVideo.kill('SIGKILL'); ffmpegVideo = null; }
  if (ffmpegAudio) { ffmpegAudio.kill('SIGKILL'); ffmpegAudio = null; }
}

// ── WebRTC + Signaling ─────────────────────────────────────────────────────
let ws = null;

function openWS() {
  ws = new WebSocket(SIGNAL_URL);

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'register', role: 'agent-stream', id: STREAM_ID }));
    console.log('[Signal] Registered as', STREAM_ID);
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    console.log('[Signal] msg:', msg.type, 'from:', msg.from);

    if (msg.type === 'offer') {
      const viewerId = msg.from;

      if (viewers.has(viewerId)) {
        try { viewers.get(viewerId).pc.close(); } catch {}
        viewers.delete(viewerId);
      }

      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      const entry = { pc, dcVideo: null, pendingIce: [] };
      viewers.set(viewerId, entry);

      // Audio via WebRTC track
      pc.addTrack(audioTrack, audioStream);

      // DataChannel created by viewer — agent receives it here
      pc.ondatachannel = (e) => {
        if (e.channel.label !== 'video') return;
        entry.dcVideo = e.channel;
        entry.dcVideo.onopen  = () => console.log(`[DC:${viewerId}] video open`);
        entry.dcVideo.onclose = () => console.log(`[DC:${viewerId}] video closed`);
      };

      pc.onicecandidate = ({ candidate }) => {
        if (candidate && ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: 'ice', to: viewerId, candidate }));
      };

      pc.onconnectionstatechange = () => {
        console.log(`[WebRTC:${viewerId}] State:`, pc.connectionState);
        if (pc.connectionState === 'connected') startFFmpeg();
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          viewers.delete(viewerId);
          try { pc.close(); } catch {}
          if (viewers.size === 0) stopFFmpeg();
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
      entry.pendingIce.forEach(c => { try { pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} });
      entry.pendingIce = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', to: viewerId, sdp: answer.sdp }));
    }

    if (msg.type === 'ice') {
      const entry = viewers.get(msg.from);
      if (!entry) return;
      if (entry.pc.remoteDescription) {
        try { await entry.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
      } else {
        entry.pendingIce.push(msg.candidate);
      }
    }
  });

  ws.on('close', () => {
    console.log('[Signal] Disconnected, reconnecting...');
    stopFFmpeg();
    viewers.forEach(({ pc }) => { try { pc.close(); } catch {} });
    viewers.clear();
    setTimeout(openWS, 3000);
  });
  ws.on('error', (e) => console.error('[Signal] Error:', e.message));
}

openWS();
