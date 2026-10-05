# game-webrtc

Controle remoto de mouse/teclado via WebRTC + stream de tela via MediaSource.

## Estrutura

```
public/                  ← clonar no servidor Ubuntu (nginx)
├── server-ws/           ← Node.js: signaling WebSocket (:8080)
├── server-gamepad/      ← estático: controle mobile (index.html)
└── server-stream/       ← estático: viewer da tela (index.html)

local/                   ← rodar no seu PC Windows
├── agent.js             ← controle WebRTC (conecta no server-ws)
├── stream-agent.js      ← captura tela com ffmpeg → WebSocket (:8081)
├── input-worker.js      ← worker thread nut-js
└── package.json
```

---

## Servidor Ubuntu (public/)

### 1. server-ws
```bash
cd public/server-ws
npm install
node signaling-server.js
```

### 2. server-gamepad e server-stream
Sirva as pastas estaticamente com nginx:

```nginx
server {
    listen 80;
    server_name SEU_DOMINIO;

    # Signaling WebSocket
    location /ws {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # Controle mobile
    location /gamepad {
        root /caminho/para/game-webrtc/public;
        try_files /server-gamepad/index.html =404;
    }

    # Viewer stream
    location /stream {
        root /caminho/para/game-webrtc/public;
        try_files /server-stream/index.html =404;
    }
}
```

---

## PC Windows (local/)

### Pré-requisitos
- Node.js 18+
- Python 3 + Visual Studio Build Tools (para nut-js)
- ffmpeg no PATH

### Instalar
```bash
cd local
npm install
```

### Rodar
```bash
# Controle (WebRTC DataChannel)
node agent.js

# Stream de tela (ffmpeg → WebSocket)
node stream-agent.js
```

### Configurar IPs
- `local/agent.js` → `SIGNAL_URL`: endereço do server-ws público
- `local/stream-agent.js` → `RESOLUTION`: resolução do seu monitor
- `public/server-gamepad/index.html` → campo URL: endereço do server-ws público
- `public/server-stream/index.html` → `WS_URL`: IP/porta do stream-agent (seu PC)

---

## Portas

| Serviço | Porta | Onde |
|---------|-------|------|
| server-ws (signaling) | 8080 | Ubuntu |
| stream-agent (vídeo) | 8081 | Windows |
