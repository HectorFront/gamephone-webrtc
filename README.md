# game-webrtc

Controle remoto de mouse/teclado via WebRTC + stream de tela via WebRTC Video Track.

## Estrutura

```
public/                  ← clonar no servidor Ubuntu (nginx)
├── server-ws/           ← Node.js: signaling WebSocket (:8080)
├── server-gamepad/      ← estático: controle mobile (index.html)
└── server-stream/       ← estático: viewer da tela (index.html)

local/                   ← rodar no seu PC Windows
├── agent.js             ← controle WebRTC (conecta no server-ws)
├── stream-agent.js      ← captura tela com ffmpeg → WebRTC Video Track
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

---

### Instalando o ffmpeg

1. Acesse https://www.gyan.dev/ffmpeg/builds/ e baixe o arquivo:
   **`ffmpeg-release-essentials.zip`**

2. Extraia o zip. Dentro haverá uma pasta como `ffmpeg-7.x.x-essentials_build`.

3. Renomeie essa pasta para `ffmpeg` e mova para a raiz do C:
   ```
   C:\ffmpeg\
   ├── bin\
   │   ├── ffmpeg.exe
   │   ├── ffplay.exe
   │   └── ffprobe.exe
   ├── doc\
   └── presets\
   ```

4. Adicione o ffmpeg ao PATH do sistema via PowerShell (executar como Administrador):
   ```powershell
   [Environment]::SetEnvironmentVariable("Path", $env:Path + ";C:\ffmpeg\bin", "Machine")
   ```

5. Feche e reabra o terminal, depois confirme:
   ```powershell
   ffmpeg -version
   ```
   Deve exibir a versão instalada.

---

### Instalar dependências do projeto
```bash
cd local
npm install
```

### Instalar pm2 (uma vez)
```bash
npm install -g pm2
```

### Rodar com pm2
```bash
cd local
pm2 start ecosystem.config.js
```

### Comandos úteis
```bash
pm2 list                  # status dos processos
pm2 logs                  # logs em tempo real
pm2 logs agent            # logs só do agent
pm2 logs stream           # logs só do stream
pm2 restart agent         # reiniciar agent
pm2 restart stream        # reiniciar stream
pm2 stop all              # parar tudo
pm2 delete all            # remover da lista
```

### Iniciar automaticamente com o Windows
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```
> Siga o comando gerado pelo `pm2 startup` para registrar o serviço no Windows.

### Configurar
- `local/agent.js` → `SIGNAL_URL`: endereço do server-ws público
- `local/stream-agent.js` → `WIDTH` / `HEIGHT` / `FPS`: resolução e framerate da captura
- `public/server-gamepad/index.html` → input URL já preenchido com `wss://game.mexpenses.com.br/ws`
- `public/server-stream/index.html` → conecta via WebRTC, sem configuração de IP necessária

---

## Portas

| Serviço | Porta | Onde |
|---------|-------|------|
| server-ws (signaling) | 8080 | Ubuntu |

> O stream de vídeo trafega pelo canal WebRTC (P2P via STUN), sem necessidade de porta exposta ou tunnel no Windows.
