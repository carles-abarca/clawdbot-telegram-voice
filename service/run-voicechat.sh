#!/bin/bash
# Wrapper script per executar el servei de VoiceChat

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_PATH="$HOME/jarvis/dev/repos/tgcalls-env"

# Activar virtualenv
source "$VENV_PATH/bin/activate"

# Executar servei
exec python "$SCRIPT_DIR/telegram-voicechat-service.py" "$@"
