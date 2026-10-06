const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, MediaStream } = require('@roamhq/wrtc');
const { RTCVideoSource, RTCAudioSource } = require('@roamhq/wrtc').nonstandard;
const WebSocket = require('ws');
const { spawn } = require('child_process');

const SIGNAL_URL   = 'wss://game.mexpenses.com.br/ws';
const STREAM_ID    = 'stream-agent';
// rode: ffmpeg -list_devices true -f dshow -i dummy
const AUDIO_DEVICE = 'CABLE Output (VB-Audio Virtual Cable)';

const WIDTH  = 1280;
const HEIGHT = 720;
const FPS    = 30;

// ── Vídeo ──────────────────────────────────────────────────────────────────
const FRAME_SIZE = WIDTH * HEIGHT * 3 / 2;
const frameAB    = new ArrayBuffer(FRAME_SIZE);
const i420Data   = new Uint8ClampedArray(frameAB);
const ringBuf    = Buffer.from(frameAB);
const i420Frame  = { width: WIDTH, height: HEIGHT, data: i420Data };
let   writePos   = 0;

// ── Áudio ──────────────────────────────────────────────────────────────────
const SAMPLE_RATE       = 44100;
const CHANNELS          = 2;
const SAMPLES_FRAME     = SAMPLE_RATE / 100; // 10ms = 441 samples
const AUDIO_FRAME_BYTES = SAMPLES_FRAME * CHANNELS * 2; // s16le
const audioAB           = new ArrayBuffer(AUDIO_FRAME_BYTES);
const audioSamples      = new Int16Array(audioAB);
const audioRing         = Buffer.from(audioAB);
let   audioWritePos     = 0;

const videoSource = new RTCVideoSource();
const audioSource = new RTCAudioSource();
const videoTrack  = videoSource.createTrack();
const audioTrack  = audioSource.createTrack();
const stream      = new MediaStream([videoTrack, audioTrack]);

let ffmpeg      = null;
let ffmpegAudio = null;

function startFFmpeg() {
  if (ffmpeg) return;
  console.log('[Stream] Iniciando ffmpeg vídeo...');

  ffmpeg = spawn('ffmpeg', [
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-f', 'gdigrab',
    '-framerate', String(FPS),
    '-probesize', '32',
    '-i', 'desktop',
    '-vf', `scale=${WIDTH}:${HEIGHT}`,
    '-f', 'rawvideo',
    '-pix_fmt', 'yuv420p',
    '-threads', '4',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  ffmpeg.stderr.on('data', (d) => console.error('[ffmpeg]', d.toString().trim()));

  let frameCount = 0;
  writePos = 0;
  ffmpeg.stdout.on('data', (raw) => {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    let src = 0;
    while (src < chunk.length) {
      const space = Math.min(chunk.length - src, FRAME_SIZE - writePos);
      chunk.copy(ringBuf, writePos, src, src + space);
      writePos += space;
      src += space;
      if (writePos === FRAME_SIZE) {
        frameCount++;
        if (frameCount % 30 === 0) console.log('[Stream] frames enviados:', frameCount);
        try { videoSource.onFrame(i420Frame); } catch(e) { console.error('[onFrame]', e.message); }
        writePos = 0;
      }
    }
  });

  ffmpeg.on('close', (code) => {
    console.log(`[Stream] ffmpeg vídeo encerrou (${code})`);
    ffmpeg = null;
  });

  // ── Áudio ────────────────────────────────────────────────────────────────
  console.log('[Stream] Iniciando ffmpeg áudio...');
  ffmpegAudio = spawn('ffmpeg', [
    '-fflags', 'nobuffer',
    '-f', 'dshow',
    '-i', `audio=${AUDIO_DEVICE}`,
    '-f', 's16le',
    '-ar', String(SAMPLE_RATE),
    '-ac', String(CHANNELS),
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
    console.log(`[Stream] ffmpeg áudio encerrou (${code})`);
    ffmpegAudio = null;
  });
}

function stopFFmpeg() {
  if (ffmpeg)      { ffmpeg.kill('SIGKILL');      ffmpeg = null; }
  if (ffmpegAudio) { ffmpegAudio.kill('SIGKILL'); ffmpegAudio = null; }
}

// ── WebRTC + Signaling ─────────────────────────────────────────────────────
const peers = new Map(); // viewerId -> { pc, pendingIce }
let ws  = null;

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
      const viewerId = msg.from;

      // fecha conexão anterior deste viewer se existir
      if (peers.has(viewerId)) {
        try { peers.get(viewerId).pc.close(); } catch {}
        peers.delete(viewerId);
      }

      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      const entry = { pc, pendingIce: [] };
      peers.set(viewerId, entry);

      pc.onicecandidate = ({ candidate }) => {
        if (candidate && ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: 'ice', to: viewerId, candidate }));
      };

      pc.onconnectionstatechange = () => {
        console.log(`[WebRTC:${viewerId}] State:`, pc.connectionState);
        if (pc.connectionState === 'connected') startFFmpeg();
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          peers.delete(viewerId);
          try { pc.close(); } catch {}
          if (peers.size === 0) stopFFmpeg();
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
      pc.addTrack(videoTrack, stream);
      pc.addTrack(audioTrack, stream);
      entry.pendingIce.forEach(c => { try { pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} });
      entry.pendingIce = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const sdp = answer.sdp
        .replace(/a=rtcp-fb:(.+) transport-cc/g, 'a=rtcp-fb:$1 transport-cc')
        .replace(/(m=video[\s\S]*?)(a=rtpmap)/,
          '$1a=fmtp:96 x-google-min-bitrate=2000;x-google-max-bitrate=6000\r\n$2');
      ws.send(JSON.stringify({ type: 'answer', to: viewerId, sdp }));
    }

    if (msg.type === 'ice') {
      const entry = peers.get(msg.from);
      if (!entry) return;
      if (entry.pc.remoteDescription) {
        try { await entry.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
      } else {
        entry.pendingIce.push(msg.candidate);
      }
    }
  });

  ws.on('close', () => {
    console.log('[Signal] Desconectado, reconectando...');
    stopFFmpeg();
    peers.forEach(({ pc }) => { try { pc.close(); } catch {} });
    peers.clear();
    setTimeout(openWS, 3000);
  });
  ws.on('error', (e) => console.error('[Signal] Erro:', e.message));
}

openWS();
