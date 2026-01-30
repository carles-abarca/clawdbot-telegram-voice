#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

INSTALL_DIR="$HOME/.clawdbot/telegram-userbot"
VENV_DIR="$INSTALL_DIR/venv"
SERVICE_NAME="telegram-voice"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

echo -e "${GREEN}📦 Instal·lant Telegram Voice Service...${NC}"
echo "   Install dir: $INSTALL_DIR"

# 1. Crear directori
mkdir -p "$INSTALL_DIR"

# 2. Copiar servei
echo -e "${YELLOW}→ Copiant servei...${NC}"
cp "$REPO_DIR/service/telegram-voice-service.py" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/telegram-voice-service.py"

# 3. Verificar venv existent (creat pel plugin)
if [ ! -d "$VENV_DIR" ]; then
    echo -e "${YELLOW}→ Creant entorn virtual Python...${NC}"
    python3 -m venv "$VENV_DIR"
fi

# 4. Instal·lar dependències addicionals (si cal)
echo -e "${YELLOW}→ Verificant dependències...${NC}"
source "$VENV_DIR/bin/activate"
# Les dependències bàsiques ja estan instal·lades pel plugin
deactivate

# 5. Instal·lar systemd service (Linux only)
if [[ "$(uname)" == "Linux" ]]; then
    echo -e "${YELLOW}→ Configurant systemd service...${NC}"
    mkdir -p "$HOME/.config/systemd/user"
    
    cat > "$HOME/.config/systemd/user/$SERVICE_NAME.service" << EOF
[Unit]
Description=Telegram Voice Service for Clawdbot
After=network.target

[Service]
Type=simple
ExecStart=$VENV_DIR/bin/python $INSTALL_DIR/telegram-voice-service.py
Restart=on-failure
RestartSec=5
Environment=PYTHONUNBUFFERED=1
MemoryMax=1G
MemoryHigh=800M

[Install]
WantedBy=default.target
EOF

    systemctl --user daemon-reload
    systemctl --user enable "$SERVICE_NAME"
    
    echo -e "${GREEN}✅ Systemd service instal·lat!${NC}"
    echo "   Per iniciar: systemctl --user start $SERVICE_NAME"
    echo "   Per veure logs: journalctl --user -u $SERVICE_NAME -f"
fi

# macOS launchd (futur)
if [[ "$(uname)" == "Darwin" ]]; then
    echo -e "${YELLOW}⚠️  macOS: Cal configurar launchd manualment${NC}"
    echo "   Veure: docs/ARCHITECTURE.md"
fi

echo ""
echo -e "${GREEN}✅ Instal·lació completada!${NC}"
echo ""
echo "Per iniciar el servei:"
echo "  systemctl --user start $SERVICE_NAME"
echo ""
echo "Per verificar l'estat:"
echo "  systemctl --user status $SERVICE_NAME"
