# PROJECT.md - Telegram Userbot Plugin Development

## 📋 Status: Active Development

**Last Updated:** 2026-01-30 12:14

## 🎯 Vision

Un **userbot de Telegram** (usuari normal, NO bot de BotFather) que permeti:
- 💬 Escriure missatges de text
- 🎤 Enviar/rebre notes de veu amb transcripció i resposta per veu
- 🧠 Tot integrat amb Clawdbot (personalitat, memòria, eines)

## ✅ Fites Aconseguides

### Plugin Discovery (2026-01-29)
- [x] Plugin detectat per `clawdbot plugins list`
- [x] Plugin s'habilita amb `clawdbot plugins enable telegram-userbot`
- [x] Documentació del format correcte de plugin
- [x] Consistència d'IDs (package.json name sense prefix `clawdbot-`)

### Text (2026-01-29)
- [x] Userbot Pyrogram funcionant
- [x] Rebre missatges de text de l'usuari
- [x] Enviar respostes de text
- [x] Bridge Python-Node.js via JSON-RPC stdin/stdout

### Veu - STT (2026-01-30)
- [x] Whisper.cpp instal·lat i funcionant
- [x] Transcripció de notes de veu entrants
- [x] **Detecció d'idioma amb model `medium`** (més precís)
- [x] **Transcripció amb model `small`** (més ràpid)
- [x] Flag `-l auto` explícit (per defecte Whisper assumeix anglès!)
- [x] Lectura correcta del fitxer `.txt` generat per `-otxt`

### Veu - TTS (2026-01-30)
- [x] Piper TTS instal·lat amb veu catalana
- [x] Generar àudio des de text
- [x] Enviar notes de veu com a resposta

### UX Notes de Veu (2026-01-30)
- [x] **Estat "Sending a file"** mentre transcriu (~13s)
- [x] **Marcar com a llegit** després de transcripció
- [x] **Estat "Recording voice"** o **"Typing"** segons tipus de resposta
- [x] Refresh d'estats cada 4s (Telegram expira als 5s)

### Voice-to-Voice Mode (2026-01-30)
- [x] **Activació:** Nota de veu que comença amb "Jarvis" (configurable via `BOT_NAME`)
- [x] **Resposta:** Nota de veu generada amb Piper TTS
- [x] **Fallback:** Si TTS falla, respon amb text

### Transcripció + Traducció (2026-01-30)
- [x] Notes de veu **sense "Jarvis"** demanen a Claude:
  - Transcripció original
  - Traducció a la llengua de la conversa

### Robustesa (2026-01-30)
- [x] **Cleanup de processos orfes** al iniciar el bridge
- [x] **Expansió de paths** amb `~` i `$HOME` a la config

## 📚 Arquitectura de Veu

### Flux de Notes de Veu Entrants

```
┌─────────────────────────────────────────────────────────────┐
│                    Nota de Veu Rebuda                       │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  1. Estat: "Sending a file" (refresh cada 4s)              │
│  2. Detecció idioma amb Whisper medium (~5s)                │
│  3. Transcripció amb Whisper small + idioma forçat (~8s)    │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  4. Marcar com a llegit ✓✓                                  │
│  5. Comprovar si comença amb "Jarvis"                       │
└─────────────────────────┬───────────────────────────────────┘
                          │
            ┌─────────────┴─────────────┐
            │                           │
            ▼                           ▼
┌───────────────────────┐   ┌───────────────────────┐
│ Comença amb "Jarvis"  │   │ NO comença amb Jarvis │
│                       │   │                       │
│ • Estat: Record audio │   │ • Estat: Typing       │
│ • Processar amb Claude│   │ • Demanar transcripció│
│ • Generar TTS (Piper) │   │   + traducció a Claude│
│ • Enviar nota de veu  │   │ • Enviar text         │
└───────────────────────┘   └───────────────────────┘
```

### Configuració STT (Whisper.cpp)

```json
"stt": {
  "provider": "whisper-cpp",
  "whisperPath": "~/whisper.cpp/build/bin/whisper-cli",
  "modelPath": "~/whisper.cpp/models/ggml-small.bin",
  "detectModelPath": "~/whisper.cpp/models/ggml-medium.bin",
  "language": "auto",
  "threads": 4
}
```

**Models:**
| Model | Mida | Ús | Temps (~10s àudio) |
|-------|------|-----|-------------------|
| small | 466MB | Transcripció | ~8s |
| medium | 1.5GB | Detecció idioma | ~5s |

**Flags importants:**
- `-l auto` - OBLIGATORI per auto-detect (per defecte és `en`!)
- `-otxt` - Output a fitxer `.txt`
- `--no-timestamps` - Sense timestamps

### Configuració TTS (Piper)

```json
"tts": {
  "provider": "piper",
  "piperPath": "~/piper/piper/piper",
  "voicePath": "~/piper/voices/ca_ES-upc_pau-x_low.onnx",
  "lengthScale": 0.85
}
```

**Veus disponibles:**
- `ca_ES-upc_pau-x_low.onnx` - Català (Pau, masculí) ✅
- `ca_ES-upc_ona-medium.onnx` - Català (Ona, femení)
- `es_ES-sharvard-medium.onnx` - Castellà
- `en_US-lessac-medium.onnx` - Anglès

## 🔧 Configuració Completa

```json
{
  "channels": {
    "telegram-userbot": {
      "enabled": true,
      "apiId": 37255096,
      "apiHash": "...",
      "phone": "+525548038542",
      "sessionPath": "~/.clawdbot/telegram-userbot/session",
      "pythonEnvPath": "~/.clawdbot/telegram-userbot/venv",
      "allowedUsers": [32975149],
      "stt": {
        "provider": "whisper-cpp",
        "whisperPath": "~/whisper.cpp/build/bin/whisper-cli",
        "modelPath": "~/whisper.cpp/models/ggml-small.bin",
        "detectModelPath": "~/whisper.cpp/models/ggml-medium.bin",
        "language": "auto",
        "threads": 4
      },
      "tts": {
        "provider": "piper",
        "piperPath": "~/piper/piper/piper",
        "voicePath": "~/piper/voices/ca_ES-upc_pau-x_low.onnx",
        "lengthScale": 0.85
      }
    }
  }
}
```

## 📁 Estructura de Fitxers

```
~/.clawdbot/extensions/telegram-userbot/
├── index.ts                    # Entry point
├── clawdbot.plugin.json        # Manifest
├── package.json                # @silverbacking/telegram-userbot
├── PROJECT.md                  # Aquesta documentació
├── README.md                   # Documentació pública
├── src/
│   ├── channel.ts              # Channel plugin definition
│   ├── config.ts               # Config types + expandPath()
│   ├── monitor.ts              # Inbound message handler
│   ├── runtime.ts              # Runtime access
│   ├── stt.ts                  # WhisperSTT class
│   ├── telegram-bridge.ts      # Python bridge + embedded script
│   ├── tts.ts                  # PiperTTS class
│   └── types.ts                # TypeScript types
└── dist/                       # Compiled JS
```

## 🐛 Bugs Resolts

### 1. Whisper assumeix anglès per defecte
**Problema:** Sense `-l`, Whisper usa `lang=en` i "tradueix" a anglès.
**Solució:** Passar `-l auto` explícitament.

### 2. Lectura de stdout en lloc de fitxer
**Problema:** El codi llegia `stdout` però Whisper escriu a `.txt` amb `-otxt`.
**Solució:** Llegir del fitxer `wavPath + ".txt"`.

### 3. Processos orfes després de restart
**Problema:** El bridge Python no es matava correctament al reiniciar.
**Solució:** `killOrphanedProcesses()` al iniciar que mata processos anteriors.

### 4. Accions de Telegram expiren
**Problema:** Els estats (typing, etc.) expiren als 5 segons.
**Solució:** `setInterval` per refrescar cada 4 segons.

### 5. UPLOAD_AUDIO mostra "Recording voice"
**Problema:** `ChatAction.UPLOAD_AUDIO` es mostra com "Recording voice" a Telegram.
**Solució:** Usar `UPLOAD_DOCUMENT` que mostra "Sending a file".

## 📝 TODO

### ✅ Completat Recentment (2026-01-31)
- [x] **Trucades P2P - Fase 1 (Infraestructura)**
  - Classes `Call`, `IncomingCall`, `OutgoingCall` basades en pytgcalls
  - `CallService` amb auto-answer configurable
  - Handler de trucades entrants via `RawUpdateHandler`
  - Nous mètodes JSON-RPC: `call.accept`, `call.reject`, `call.hangup`, `call.status`, `call.start`
  - Events: `call.incoming`, `call.connected`, `call.ended`
  - Integració WebRTC amb `tgcalls.NativeInstance`
  - Broadcast d'events a tots els clients connectats
  - Timeout automàtic de trucades (configurable)

### ✅ Completat (2026-01-30)
- [x] **Servei `telegram-voice`** - Separat del plugin
  - `service/telegram-voice-service.py` - JSON-RPC server
  - `src/voice-client.ts` - Client TypeScript
  - Systemd service instal·lat i funcionant
  - Gestió d'idioma per conversa integrada
  - Veure: `docs/ARCHITECTURE.md`

### 🔄 En Progrés (Trucades P2P - Fase 2)
- [ ] **Pipeline d'àudio en temps real**
  - [ ] Captura d'àudio entrant amb callback de frames
  - [ ] Buffer amb detecció de silenci (VAD)
  - [ ] Integració amb Whisper per STT durant trucada
  - [ ] Enviament d'àudio TTS a la trucada
- [ ] **Integrar voice-client al monitor.ts** - Usar servei extern
- [ ] **Gestió d'idioma al plugin** - Detectar [LANG:xx] i actualitzar

### Pròxim
- [ ] Gestió d'errors i retry més robusta
- [ ] Tests automatitzats amb trucades reals

### Publicació
- [ ] CI/CD pipeline
- [ ] Publicar a npm
- [ ] PR al catàleg de plugins de Clawdbot

## 🤝 Contributors

- **Carles Abarca** - Idea, testing, direcció
- **Jarvis (Claude)** - Implementació
