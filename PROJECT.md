# PROJECT.md - Telegram Voice Plugin Development

## 📋 Status: Active Development

**Last Updated:** 2026-01-29

## 🎯 Vision

Un **userbot de Telegram** (usuari normal, NO bot de BotFather) que permeti:
- 💬 Escriure missatges de text
- 📞 Fer trucades de veu en temps real
- 🎤 Enviar/rebre notes de veu
- 🧠 Tot integrat amb Clawdbot (personalitat, memòria, eines)

## ⚠️ Clarificació Important

**Aquest plugin és INDEPENDENT del bot de BotFather!**

| Bot BotFather | Userbot (aquest plugin) |
|---------------|------------------------|
| API Bot Telegram | API MTProto (Pyrogram) |
| No pot trucar | ✅ Pot fer trucades |
| Limitat | Accés complet |
| grammY | Pyrogram |

El plugin crea un **nou canal** per Clawdbot basat en userbot, no modifica el canal Telegram existent.

## ✅ Funcionalitats Completades

### Text
- [x] Userbot Pyrogram funcionant
- [x] Rebre missatges de text de l'usuari
- [x] Enviar respostes de text
- [x] Servei systemd (`jarvis-telegram`) executant-se en background

### Veu (Sortida)
- [x] Piper TTS instal·lat amb veu catalana (`ca_ES-upc_ona-medium`)
- [x] Generar àudio des de text
- [x] Iniciar trucades privades amb pytgcalls
- [x] Enviar àudio TTS durant la trucada (**FUNCIONA!**)
- [x] L'usuari sent la veu de Jarvis

### Veu (Entrada) 
- [ ] ❌ **BLOCAT**: py-tgcalls no suporta captura d'àudio de trucades privades P2P
- [ ] Transcriure àudio amb Whisper
- [ ] Flux complet de conversa per veu

## 🚧 Problemes Identificats

### py-tgcalls limitació
La llibreria `py-tgcalls` (Laky-64) està dissenyada per **group voice chats**, no per trucades privades P2P.

- `pytgcalls.record()` - No crea fitxer per trucades privades
- `StreamFrames` handler - No rep frames d'àudio entrant
- `RecordStream` - Només funciona per group calls

### Alternatives investigades

| Llibreria | Trucades Privades | Captura Àudio | Estat |
|-----------|-------------------|---------------|-------|
| py-tgcalls (Laky-64) | ✅ Parcial | ❌ No | Instal·lat |
| pytgvoip (bakatrouble) | ✅ Sí | ✅ Sí | Pendient instal·lar |
| tgcalls (MarshalX) | ✅ Sí | ✅ Sí | No disponible pip |

### Solució proposada

Instal·lar `pytgvoip` que:
- Usa `libtgvoip` (la llibreria oficial de Telegram)
- Té callbacks per enviar I REBRE àudio
- Requereix compilació (dependències instal·lades ✅)

## 📁 Estructura de Fitxers

```
~/jarvis/dev/repos/clawdbot-telegram-voice/
├── src/
│   ├── index.ts          # Plugin entry point
│   ├── config.ts         # Configuration types
│   └── telegram-bridge.ts # Python-Node bridge
├── python/               # (TODO) Python components
│   ├── userbot.py
│   ├── voice_handler.py
│   └── requirements.txt
├── docs/
├── skills/
├── clawdbot.plugin.json
├── package.json
└── README.md

~/jarvis-voice/
├── jarvis_userbot.session      # Pyrogram session
├── jarvis_telegram_service.py  # Text message listener
└── telegram-service.log        # Service logs

~/jarvis-voice-env/             # Python virtual environment
```

## 🔧 Configuració Actual

### Telegram Userbot
- **API ID:** 37255096
- **API Hash:** d4f55ea4e3e4f7b463d529f5869aa644
- **Session:** `~/jarvis-voice/jarvis_userbot.session`
- **Nom:** Jarvis
- **ID:** 8511187588

### Usuari Autoritzat
- **Carles ID:** 32975149

### TTS (Piper)
- **Path:** `~/piper/piper/piper`
- **Veu catalana:** `~/piper/voices/ca_ES-upc_ona-medium.onnx`
- **Rendiment:** ~0.05x real-time

### STT (Whisper)
- **Path:** `~/whisper.cpp/`
- **Models:** `~/whisper.cpp/models/`

## 📝 TODO

### Immediat
1. [ ] Instal·lar `pytgvoip` i provar captura d'àudio
2. [ ] Integrar servei de text amb Clawdbot sessions
3. [ ] Provar flux complet: veu → STT → Claude → TTS → veu

### Proper
4. [ ] Crear bridge Python ↔ Node.js adequat
5. [ ] Integrar com a channel plugin de Clawdbot
6. [ ] Gestió d'errors i retry
7. [ ] Documentació d'instal·lació

### Publicació
8. [ ] Tests automatitzats
9. [ ] CI/CD pipeline
10. [ ] Publicar a npm com `@carles-abarca/clawdbot-telegram-voice`
11. [ ] PR al catàleg de plugins de Clawdbot

## 📊 Tests Realitzats

### 2026-01-29 19:20-19:40

| Test | Resultat | Notes |
|------|----------|-------|
| Trucar a Carles | ✅ | Timeout 30-60s necessari |
| Enviar TTS català | ✅ | Carles ho sent perfectament |
| Capturar àudio | ❌ | py-tgcalls no ho suporta |
| Servei systemd | ✅ | `jarvis-telegram` actiu |
| Rebre text | ✅ | Missatges arriben correctament |

## 🤝 Contributors

- **Carles Abarca** - Idea, testing
- **Jarvis (Claude)** - Implementació

## 📜 License

MIT
