#!/bin/bash
#
# Clawdbot Telegram Userbot Plugin - Installation Script
# ======================================================
#
# This script installs the Python services for the telegram-userbot plugin.
#
# Components:
#   1. Core services (bridge + voice) - Uses Pyrogram
#   2. VoiceChat service (optional) - Uses Hydrogram + py-tgcalls
#
# Usage:
#   ./install.sh              # Install core only
#   ./install.sh --all        # Install core + voicechat
#   ./install.sh --voicechat  # Install voicechat only
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${CLAWDBOT_USERBOT_DIR:-$HOME/.clawdbot/telegram-userbot}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[install]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# Parse arguments
INSTALL_CORE=false
INSTALL_VOICECHAT=false

if [ $# -eq 0 ]; then
    INSTALL_CORE=true
fi

for arg in "$@"; do
    case $arg in
        --all)
            INSTALL_CORE=true
            INSTALL_VOICECHAT=true
            ;;
        --voicechat)
            INSTALL_VOICECHAT=true
            ;;
        --core)
            INSTALL_CORE=true
            ;;
        --help|-h)
            echo "Usage: $0 [--core] [--voicechat] [--all]"
            echo ""
            echo "Options:"
            echo "  --core       Install core services (bridge + voice)"
            echo "  --voicechat  Install voice chat streaming service"
            echo "  --all        Install everything"
            echo ""
            echo "Environment variables:"
            echo "  CLAWDBOT_USERBOT_DIR  Installation directory (default: ~/.clawdbot/telegram-userbot)"
            exit 0
            ;;
    esac
done

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Clawdbot Telegram Userbot Plugin - Installer"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  Install directory: $INSTALL_DIR"
echo "  Core services:     $INSTALL_CORE"
echo "  VoiceChat:         $INSTALL_VOICECHAT"
echo ""

# Check Python version
log "Checking Python version..."
PYTHON_VERSION=$(python3 --version 2>&1 | grep -oP '\d+\.\d+' | head -1)
PYTHON_MAJOR=$(echo $PYTHON_VERSION | cut -d. -f1)
PYTHON_MINOR=$(echo $PYTHON_VERSION | cut -d. -f2)

if [ "$PYTHON_MAJOR" -lt 3 ] || ([ "$PYTHON_MAJOR" -eq 3 ] && [ "$PYTHON_MINOR" -lt 10 ]); then
    error "Python 3.10+ required (found $PYTHON_VERSION)"
fi
success "Python $PYTHON_VERSION"

# Create installation directory
log "Creating installation directory..."
mkdir -p "$INSTALL_DIR"

# Install core services
if [ "$INSTALL_CORE" = true ]; then
    log "Installing core services (bridge + voice)..."
    
    VENV_CORE="$INSTALL_DIR/venv"
    
    if [ ! -d "$VENV_CORE" ]; then
        log "Creating Python virtual environment..."
        python3 -m venv "$VENV_CORE"
    fi
    
    log "Installing Python dependencies..."
    "$VENV_CORE/bin/pip" install --upgrade pip wheel -q
    "$VENV_CORE/bin/pip" install -r "$SCRIPT_DIR/python/requirements-core.txt" -q
    
    log "Copying Python services..."
    cp "$SCRIPT_DIR/python/bridge/telegram-text-bridge.py" "$INSTALL_DIR/" 2>/dev/null || true
    cp "$SCRIPT_DIR/python/voice/telegram-voice-service.py" "$INSTALL_DIR/" 2>/dev/null || true
    cp "$SCRIPT_DIR/python/voice/telegram-voice-cli.py" "$INSTALL_DIR/" 2>/dev/null || true
    
    # Copy from service/ if python/ doesn't have them yet
    if [ -f "$SCRIPT_DIR/service/telegram-voice-service.py" ]; then
        cp "$SCRIPT_DIR/service/telegram-voice-service.py" "$INSTALL_DIR/"
    fi
    
    log "Installing systemd services..."
    mkdir -p "$HOME/.config/systemd/user"
    
    # Generate systemd unit for voice service
    cat > "$HOME/.config/systemd/user/telegram-voice.service" << EOF
[Unit]
Description=Telegram Voice Service for Clawdbot
After=network.target

[Service]
Type=simple
Environment=PATH=$VENV_CORE/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=$INSTALL_DIR
ExecStart=$VENV_CORE/bin/python telegram-voice-service.py
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=telegram-voice

[Install]
WantedBy=default.target
EOF

    systemctl --user daemon-reload
    success "Core services installed"
fi

# Install voicechat service
if [ "$INSTALL_VOICECHAT" = true ]; then
    log "Installing VoiceChat streaming service..."
    
    VENV_VOICECHAT="$INSTALL_DIR/venv-voicechat"
    
    if [ ! -d "$VENV_VOICECHAT" ]; then
        log "Creating Python virtual environment for VoiceChat..."
        python3 -m venv "$VENV_VOICECHAT"
    fi
    
    log "Installing Python dependencies (this may take a while)..."
    "$VENV_VOICECHAT/bin/pip" install --upgrade pip wheel -q
    "$VENV_VOICECHAT/bin/pip" install -r "$SCRIPT_DIR/python/requirements-voicechat.txt" -q
    
    log "Copying VoiceChat service..."
    cp "$SCRIPT_DIR/service/telegram-voicechat-service.py" "$INSTALL_DIR/" 2>/dev/null || \
    cp "$SCRIPT_DIR/python/voicechat/telegram-voicechat-service.py" "$INSTALL_DIR/" 2>/dev/null || true
    
    # Create separate session for voicechat
    if [ -f "$INSTALL_DIR/session.session" ] && [ ! -f "$INSTALL_DIR/session-voicechat.session" ]; then
        log "Creating separate session for VoiceChat..."
        cp "$INSTALL_DIR/session.session" "$INSTALL_DIR/session-voicechat.session"
    fi
    
    # Generate systemd unit for voicechat service
    cat > "$HOME/.config/systemd/user/telegram-voicechat.service" << EOF
[Unit]
Description=Telegram VoiceChat Streaming Service
After=network.target

[Service]
Type=simple
Environment=PATH=$VENV_VOICECHAT/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=$INSTALL_DIR
ExecStart=$VENV_VOICECHAT/bin/python telegram-voicechat-service.py
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=telegram-voicechat

[Install]
WantedBy=default.target
EOF

    systemctl --user daemon-reload
    success "VoiceChat service installed"
fi

# Copy test script
log "Installing test suite..."
cp "$SCRIPT_DIR/python/test-telegram-userbot.sh" "$INSTALL_DIR/" 2>/dev/null || true
chmod +x "$INSTALL_DIR/test-telegram-userbot.sh" 2>/dev/null || true

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Installation Complete!"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Configure API credentials in clawdbot.json:"
echo "     channels.telegram-userbot.apiId"
echo "     channels.telegram-userbot.apiHash"
echo ""
echo "  2. Create Telegram session:"
echo "     cd $INSTALL_DIR"
echo "     $INSTALL_DIR/venv/bin/python -c 'from pyrogram import Client; Client(\"session\", api_id=XXX, api_hash=\"YYY\").run()'"
echo ""
echo "  3. Start services:"
echo "     systemctl --user enable --now telegram-voice"
if [ "$INSTALL_VOICECHAT" = true ]; then
echo "     systemctl --user enable --now telegram-voicechat"
fi
echo ""
echo "  4. Run tests:"
echo "     $INSTALL_DIR/test-telegram-userbot.sh --quick"
echo ""
