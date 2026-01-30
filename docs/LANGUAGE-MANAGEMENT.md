# Gestió d'Idioma per Conversa

**Status:** 📋 Planificat (pendent implementació)
**Data:** 2026-01-30
**Autor:** Jarvis

## 🎯 Objectiu

Millorar la fluïdesa de les converses d'àudio forçant l'idioma de STT/TTS en lloc d'usar detecció automàtica, que pot ser imprecisa en frases curtes.

## 📋 Requisits

1. **Idioma per defecte:** Català (`ca`)
2. **Canvi d'idioma:** L'usuari pot demanar canviar d'idioma durant la conversa
3. **Persistència:** L'idioma actiu es manté entre missatges fins que es canviï
4. **Aplicació:** Afecta tant STT (Whisper) com TTS (Piper)

## 🏗️ Arquitectura

### Fitxer d'Estat

```
~/.clawdbot/telegram-userbot/conversation-state.json
```

```json
{
  "users": {
    "32975149": {
      "language": "ca",
      "lastUpdated": "2026-01-30T18:30:00.000Z"
    }
  },
  "defaults": {
    "language": "ca"
  }
}
```

### Idiomes Suportats

| Codi | Idioma | Veu TTS | Model STT |
|------|--------|---------|-----------|
| `ca` | Català | `ca_ES-upc_pau-x_low.onnx` | Whisper (forçat `ca`) |
| `es` | Castellà | `es_ES-sharvard-medium.onnx` | Whisper (forçat `es`) |
| `en` | Anglès | `en_US-lessac-medium.onnx` | Whisper (forçat `en`) |

### Flux de Canvi d'Idioma

```
┌─────────────────────────────────────────────────────────────┐
│  Usuari: "A partir d'ara parlem en castellà"               │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  1. STT transcriu el missatge (encara en idioma anterior)   │
│  2. Clawdbot processa i detecta petició de canvi d'idioma   │
│  3. Clawdbot actualitza conversation-state.json             │
│  4. Clawdbot confirma: "Perfecto, ahora hablamos en español"│
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Següent missatge de veu:                                   │
│  • STT usa idioma forçat (es)                               │
│  • TTS usa veu castellana                                   │
└─────────────────────────────────────────────────────────────┘
```

## 🔧 Canvis Necessaris

### 1. Nou fitxer: `src/language-state.ts`

```typescript
interface ConversationState {
  users: {
    [userId: string]: {
      language: SupportedLanguage;
      lastUpdated: string;
    };
  };
  defaults: {
    language: SupportedLanguage;
  };
}

type SupportedLanguage = 'ca' | 'es' | 'en';

export class LanguageState {
  private statePath: string;
  private state: ConversationState;
  
  constructor(basePath: string) {
    this.statePath = path.join(basePath, 'conversation-state.json');
    this.load();
  }
  
  getLanguage(userId: string): SupportedLanguage {
    return this.state.users[userId]?.language 
      ?? this.state.defaults.language;
  }
  
  setLanguage(userId: string, language: SupportedLanguage): void {
    this.state.users[userId] = {
      language,
      lastUpdated: new Date().toISOString()
    };
    this.save();
  }
  
  private load(): void { /* ... */ }
  private save(): void { /* ... */ }
}
```

### 2. Modificar `src/stt.ts`

```typescript
// Abans
async transcribe(wavPath: string): Promise<string>

// Després  
async transcribe(wavPath: string, forceLanguage?: SupportedLanguage): Promise<string>
```

- Si `forceLanguage` és definit, usar `-l {forceLanguage}` en lloc de `-l auto`
- Eliminar el pas de detecció d'idioma (ja no cal)

### 3. Modificar `src/tts.ts`

```typescript
// Mapa d'idioma a veu
const VOICE_MAP: Record<SupportedLanguage, string> = {
  ca: 'ca_ES-upc_pau-x_low.onnx',
  es: 'es_ES-sharvard-medium.onnx', 
  en: 'en_US-lessac-medium.onnx'
};

// Generar amb la veu correcta segons idioma
async synthesize(text: string, language: SupportedLanguage): Promise<string>
```

### 4. Modificar `src/monitor.ts`

```typescript
// Al processar nota de veu:
const language = languageState.getLanguage(userId);
const transcript = await stt.transcribe(wavPath, language);

// Al generar resposta TTS:
const audioPath = await tts.synthesize(response, language);
```

### 5. Hook per Clawdbot (detecció de canvi d'idioma)

Clawdbot necessita un mecanisme per actualitzar l'idioma. Opcions:

**Opció A: Metadata a la resposta**
```json
{
  "text": "Perfecto, ahora hablamos en español",
  "setLanguage": "es"
}
```

**Opció B: Comanda especial**
El bridge exposa un mètode `setLanguage(userId, lang)` via JSON-RPC.

**Opció C: Instrucció al system prompt** (recomanat)
Afegir al system prompt de Clawdbot:
```
Quan l'usuari demani canviar d'idioma en una conversa de veu,
inclou al principi de la teva resposta: [LANG:xx] on xx és el codi.
Exemple: [LANG:es] Perfecto, ahora hablamos en español.
```

El bridge detecta el tag `[LANG:xx]`, actualitza l'estat, i el treu del text.

## 📊 Beneficis

1. **Més precisió STT:** Forçar idioma evita errors de detecció
2. **Menys latència:** No cal el pas de detecció (~5s menys)
3. **Consistència:** La veu TTS sempre coincideix amb l'idioma
4. **UX natural:** L'usuari simplement diu "parlem en X"

## ⚠️ Consideracions

- **Canvi d'idioma "accidental":** Si l'usuari diu una frase en altre idioma sense voler canviar, Clawdbot ha de ser intel·ligent i no canviar.
- **Frases mixtes:** Amb idioma forçat, paraules d'altres idiomes poden transcriure's malament. Acceptable trade-off.
- **Reset:** Considerar afegir comanda "reset idioma" per tornar al defecte.

## 📝 Tasques d'Implementació

- [ ] Crear `src/language-state.ts`
- [ ] Modificar `src/stt.ts` per acceptar idioma forçat
- [ ] Modificar `src/tts.ts` per seleccionar veu segons idioma
- [ ] Modificar `src/monitor.ts` per usar LanguageState
- [ ] Afegir detecció de tag `[LANG:xx]` al bridge
- [ ] Actualitzar system prompt de Clawdbot
- [ ] Tests amb els 3 idiomes
- [ ] Documentar a README.md
