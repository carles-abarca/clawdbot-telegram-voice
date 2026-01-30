# Quick Start Guide

Get voice-to-voice conversations with your Clawdbot in 15 minutes!

## Prerequisites

- Linux (Ubuntu/Debian) or macOS
- Python 3.10+
- Node.js 18+
- Clawdbot installed and running
- Telegram account

## Step 1: Get Telegram API Credentials (2 min)

1. Go to [my.telegram.org](https://my.telegram.org)
2. Log in with your phone number
3. Click "API development tools"
4. Create a new application (any name/description)
5. Save your `api_id` and `api_hash`

## Step 2: Install the Plugin (3 min)

```bash
# Clone
git clone https://github.com/silverbacking/clawdbot-telegram-userbot
cd clawdbot-telegram-userbot

# Build
npm install
npm run build

# Link to Clawdbot
mkdir -p ~/.clawdbot/extensions
ln -s $(pwd) ~/.clawdbot/extensions/telegram-userbot
```

## Step 3: Set Up Python Environment (3 min)

```bash
# Create venv
mkdir -p ~/.clawdbot/telegram-userbot
python3 -m venv ~/.clawdbot/telegram-userbot/venv
source ~/.clawdbot/telegram-userbot/venv/bin/activate

# Install dependencies
pip install pyrogram tgcrypto faster-whisper
```

## Step 4: Install Piper TTS (3 min)

```bash
mkdir -p ~/piper && cd ~/piper

# Download Piper (adjust for your architecture)
wget https://github.com/rhasspy/piper/releases/download/v1.2.0/piper_amd64.tar.gz
tar -xzf piper_amd64.tar.gz

# Download English voice
mkdir -p voices && cd voices
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json
```

## Step 5: Create Telegram Session (2 min)

```bash
source ~/.clawdbot/telegram-userbot/venv/bin/activate

python3 << 'EOF'
from pyrogram import Client

app = Client(
    "session",
    api_id=YOUR_API_ID,        # Replace with your api_id
    api_hash="YOUR_API_HASH",  # Replace with your api_hash
    workdir="/home/YOUR_USER/.clawdbot/telegram-userbot"
)
app.run()
EOF
```

Enter your phone number and verification code when prompted.

## Step 6: Configure Clawdbot (2 min)

Add to `~/.clawdbot/clawdbot.json`:

```json
{
  "channels": {
    "telegram-userbot": {
      "enabled": true,
      "apiId": YOUR_API_ID,
      "apiHash": "YOUR_API_HASH",
      "phone": "+1234567890",
      "sessionPath": "~/.clawdbot/telegram-userbot/session",
      "pythonEnvPath": "~/.clawdbot/telegram-userbot/venv",
      "allowedUsers": [YOUR_TELEGRAM_USER_ID],
      "tts": {
        "provider": "piper",
        "piperPath": "~/piper/piper/piper",
        "voicePath": "~/piper/voices/en_US-lessac-medium.onnx"
      }
    }
  },
  "plugins": {
    "load": {
      "paths": ["~/.clawdbot/extensions/telegram-userbot"]
    },
    "entries": {
      "telegram-userbot": { "enabled": true }
    }
  }
}
```

## Step 7: Start the Voice Service

```bash
# Copy voice service files
cp telegram-voice-service.py ~/.clawdbot/telegram-userbot/
cp telegram-voice-cli.py ~/.clawdbot/telegram-userbot/

# Start service
cd ~/.clawdbot/telegram-userbot
source venv/bin/activate
nohup python3 telegram-voice-service.py &

# Verify it's running
python3 telegram-voice-cli.py status
```

## Step 8: Restart Clawdbot

```bash
clawdbot gateway restart
```

## 🎉 Done!

Open Telegram and send a message to your userbot account. Try a voice note starting with "Jarvis" (or your bot's name) to get a voice response!

## Troubleshooting

### Find your Telegram User ID

```bash
python3 << 'EOF'
from pyrogram import Client
import asyncio

async def main():
    app = Client("session", workdir="~/.clawdbot/telegram-userbot")
    await app.start()
    async for dialog in app.get_dialogs(limit=1):
        pass
    me = await app.get_me()
    print(f"Your user ID: {me.id}")
    await app.stop()

asyncio.run(main())
EOF
```

### Voice service not working

```bash
# Check status
python3 telegram-voice-cli.py status

# Check logs
tail -f /tmp/voice-service.log
```

### Session locked

```bash
pkill -f telegram-text-bridge.py
```
