# Investigació: Solucions per al Bridge Pyrogram

## Problema
El bridge actual usa `asyncio.run()` amb `await app.start()`, però Pyrogram no rep events (missatges) amb aquest patró. Només funciona amb `app.run()`.

## Opció 1: Usar `app.run(main())` (RECOMANADA)

Segons la documentació de Pyrogram, `app.run()` pot acceptar una corutina:

```python
from pyrogram import Client, filters

app = Client("session", api_id=..., api_hash=..., workdir=...)

@app.on_message(filters.all)
async def handler(client, message):
    emit_event("message", {"text": message.text})

async def main():
    """Corutina que s'executa dins del context de Pyrogram"""
    # Aquí podem fer el stdin reader!
    while running:
        line = await asyncio.get_event_loop().run_in_executor(None, sys.stdin.readline)
        if line:
            handle_request(line)
        await asyncio.sleep(0.1)

# Això executa main() DINS del loop de Pyrogram
app.run(main())
```

### Avantatges
- Mínim canvi al codi existent
- Pyrogram gestiona el loop correctament
- Els handlers funcionen

### Implementació
1. Moure el registre de handlers amb decoradors FORA de la classe
2. Canviar `asyncio.run(bridge.run())` per `app.run(bridge.main_loop())`
3. El stdin reader s'executa dins del context de Pyrogram

## Opció 2: Threading

Usar un thread separat per Pyrogram:

```python
import threading
import asyncio

def pyrogram_thread():
    """Thread dedicat per Pyrogram"""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    
    @app.on_message(filters.all)
    async def handler(client, message):
        # Enviar a queue thread-safe
        message_queue.put({"text": message.text})
    
    app.run()

# Main thread: stdin/stdout
threading.Thread(target=pyrogram_thread, daemon=True).start()

while True:
    # Processar stdin
    # Llegir de message_queue
```

### Avantatges
- Separació clara
- No interfereix amb el loop de Pyrogram

### Desavantatges
- Més complex
- Necessita sincronització thread-safe

## Opció 3: Telethon

Canviar de Pyrogram a Telethon, que té millor integració asyncio nativa.

```python
from telethon import TelegramClient, events

client = TelegramClient('session', api_id, api_hash)

@client.on(events.NewMessage(incoming=True))
async def handler(event):
    print(f"Message: {event.message.text}")

async def main():
    await client.start()
    # Aquí podem fer altres tasques async
    while True:
        # stdin reader
        await asyncio.sleep(0.1)

asyncio.run(main())
```

### Avantatges
- Telethon és més madur
- Millor suport asyncio natiu
- Més documentació

### Desavantatges
- Cal reescriure tot el bridge
- API diferent
- pytgcalls suporta tant Pyrogram com Telethon, però hauríem de verificar

## Recomanació

**Opció 1: `app.run(main())`** és la més senzilla i requereix menys canvis.

### Canvis necessaris al bridge:

1. **telegram-bridge.ts** - Canviar l'estructura del script Python:

```python
# Globals per els handlers
bridge_instance = None

@app.on_message(filters.all)
async def on_message(client, message):
    if bridge_instance:
        await bridge_instance._handle_message(message)

class TelegramVoiceBridge:
    def __init__(self, ...):
        global bridge_instance
        bridge_instance = self
        # ...
    
    async def main_loop(self):
        """Loop principal que s'executa dins de app.run()"""
        me = await self.app.get_me()
        self.emit_event("pyrogram.ready", {...})
        
        await self.pytgcalls.start()
        self.emit_event("ready", {...})
        
        # stdin reader
        while self.running:
            # Llegir de stdin amb run_in_executor
            ...

# Entry point
if __name__ == "__main__":
    bridge = TelegramVoiceBridge(...)
    app.run(bridge.main_loop())  # <-- CANVI CLAU
```

2. **Cleanup millorat** - Assegurar que el procés Python es mata correctament quan el gateway es reinicia.

## Pròxims Passos

1. Implementar Opció 1 al bridge
2. Testejar que els missatges arriben
3. Verificar que pytgcalls funciona
4. Millorar el cleanup del procés

---
*Investigació feta 2026-01-30 01:10 CST*
