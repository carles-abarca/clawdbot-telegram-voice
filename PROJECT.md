# PROJECT.md - Telegram Userbot Plugin Development

## 📋 Status: Active Development

**Last Updated:** 2026-01-29 23:40

## 🎯 Vision

Un **userbot de Telegram** (usuari normal, NO bot de BotFather) que permeti:
- 💬 Escriure missatges de text
- 🎤 Enviar/rebre notes de veu
- 📞 Fer trucades de veu en temps real (WIP)
- 🧠 Tot integrat amb Clawdbot (personalitat, memòria, eines)

## ✅ Fites Aconseguides

### Plugin Discovery (2026-01-29)
- [x] Plugin detectat per `clawdbot plugins list`
- [x] Plugin s'habilita amb `clawdbot plugins enable telegram-userbot`
- [x] Documentació del format correcte de plugin

### Text
- [x] Userbot Pyrogram funcionant
- [x] Rebre missatges de text de l'usuari
- [x] Enviar respostes de text
- [x] Servei systemd (`jarvis-telegram`)

### Veu (Sortida)
- [x] Piper TTS instal·lat amb veu catalana
- [x] Generar àudio des de text

### Veu (Entrada) 
- [x] Whisper.cpp instal·lat i funcionant
- [ ] Integració amb voice notes de Telegram

## 📚 Lliçons Apreses: Crear un Plugin Clawdbot

### 1. Estructura de Fitxers

```
telegram-userbot/
├── index.ts              # Entry point OBLIGATORI a l'arrel
├── clawdbot.plugin.json  # Manifest del plugin
├── package.json          # Amb camp clawdbot.extensions
├── src/                  # Codi font
│   ├── telegram-bridge.ts
│   ├── stt.ts
│   └── tts.ts
└── dist/                 # Compilat (opcional amb jiti)
```

### 2. Consistència d'IDs (CRÍTIC!)

L'ID del plugin ha de coincidir a **TRES llocs**:

| Fitxer | Camp | Valor |
|--------|------|-------|
| `clawdbot.plugin.json` | `id` | `telegram-userbot` |
| `package.json` | `name` | `telegram-userbot` |
| `index.ts` | `plugin.id` | `telegram-userbot` |

⚠️ Si el `package.json` name té scope (ex: `@scope/nom`), Clawdbot extreu el nom sense scope i compara. Millor NO usar scope.

### 3. Format del clawdbot.plugin.json

```json
{
  "id": "telegram-userbot",
  "channels": ["telegram-userbot"],
  "configSchema": {
    "type": "object",
    "additionalProperties": true,
    "properties": { ... }
  },
  "uiHints": { ... }
}
```

### 4. Format del package.json

```json
{
  "name": "telegram-userbot",
  "type": "module",
  "clawdbot": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "telegram-userbot",
      "label": "Telegram Userbot",
      "selectionLabel": "Telegram Userbot (Text + Voice)",
      "docsPath": "/channels/telegram-userbot",
      "blurb": "Description"
    }
  }
}
```

### 5. Format del index.ts (CRÍTIC!)

```typescript
import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";

// Definir el channel plugin
const channelPlugin = {
  id: "telegram-userbot",
  meta: { ... },
  capabilities: { ... },
  gateway: {
    start: async (ctx) => { ... },
    stop: async () => { ... },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async (opts) => { ... },
  },
};

// OBLIGATORI: Exportar objecte amb id, name, register
const plugin = {
  id: "telegram-userbot",
  name: "Telegram Userbot",
  description: "...",
  configSchema: { ... },
  register(api: ClawdbotPluginApi) {
    api.registerChannel({ plugin: channelPlugin });
  },
};

export default plugin;
```

⚠️ **NO exportar una funció directament!** Ha de ser un objecte amb `register()`.

### 6. On Posar el Plugin

Clawdbot cerca plugins a:

1. `plugins.load.paths` (config explícita)
2. `~/.clawdbot/extensions/*.ts`
3. `~/.clawdbot/extensions/*/index.ts`

**Mètode recomanat per desenvolupament:**
```bash
ln -s /path/to/plugin ~/.clawdbot/extensions/telegram-userbot
```

O afegir a config:
```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/plugin"]
    }
  }
}
```

### 7. Comandes CLI

```bash
# Llistar plugins
clawdbot plugins list

# Info d'un plugin
clawdbot plugins info <id>

# Instal·lar (link per dev)
clawdbot plugins install -l /path/to/plugin

# Habilitar
clawdbot plugins enable <id>

# Deshabilitar
clawdbot plugins disable <id>
```

## 🚧 Problemes Identificats

### py-tgcalls limitació per trucades P2P
La llibreria `py-tgcalls` no suporta captura d'àudio en trucades privades P2P.

**Alternatives:**
- `pytgvoip` (libtgvoip) - Requereix compilació
- Notes de veu en lloc de trucades en temps real

## 📁 Fitxers Relacionats

```
~/jarvis/dev/repos/clawdbot-telegram-userbot/  # Plugin source
~/.clawdbot/extensions/telegram-userbot/       # Symlink
~/.clawdbot/clawdbot.json                      # Config
~/jarvis-voice/                                # Python components
~/jarvis-voice-env/                            # Python venv
```

## 🔧 Configuració Actual

### Telegram Userbot
- **API ID:** 37255096
- **Session:** `~/jarvis-voice/jarvis_userbot.session`

### Usuari Autoritzat
- **Carles ID:** 32975149

### TTS (Piper)
- **Path:** `~/piper/piper/piper`
- **Veu:** `~/piper/voices/ca_ES-upc_pau-x_low.onnx`

### STT (Whisper)
- **Path:** `~/whisper.cpp/build/bin/whisper-cli`
- **Model:** `~/whisper.cpp/models/ggml-small.bin`

## 📝 TODO

### Immediat
1. [ ] Integrar bridge Python-Node.js completament
2. [ ] Testejar flux text complet amb Clawdbot sessions
3. [ ] Implementar voice notes (enviar/rebre)

### Proper
4. [ ] Investigar alternatives per trucades P2P
5. [ ] Gestió d'errors i retry
6. [ ] Tests automatitzats

### Publicació
7. [ ] CI/CD pipeline
8. [ ] Publicar a npm
9. [ ] PR al catàleg de plugins de Clawdbot

## 🤝 Contributors

- **Carles Abarca** - Idea, testing
- **Jarvis (Claude)** - Implementació
