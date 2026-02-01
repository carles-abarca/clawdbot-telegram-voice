#!/usr/bin/env python3
"""
Telegram Transcriptor Service for Clawdbot

Servei independent que gestiona només:
- STT: Whisper (transcripció d'àudio a text)
- TTS: Piper (síntesi de veu)

Exposa API JSON-RPC via Unix Socket (Linux) o TCP (macOS)
"""

import asyncio
import json
import os
import sys
import signal
import tempfile
import subprocess
import platform
from pathlib import Path
from datetime import datetime
from typing import Optional, Dict, Any
import logging

# Configuració de logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
log = logging.getLogger(__name__)

# Constants
SERVICE_NAME = "telegram-transcriptor"
VERSION = "2.0.0"

# Paths segons plataforma
if platform.system() == "Linux":
    SOCKET_PATH = f"/run/user/{os.getuid()}/tts-stt.sock"
    TRANSPORT = "unix"
else:  # macOS
    SOCKET_PATH = None
    TCP_HOST = "127.0.0.1"
    TCP_PORT = 18790
    TRANSPORT = "tcp"

# Directori base
BASE_DIR = Path.home() / ".clawdbot" / "telegram-userbot"
CONFIG_PATH = BASE_DIR / "voice-service-config.json"
STATE_PATH = BASE_DIR / "conversation-state.json"
TMP_DIR = Path(tempfile.gettempdir()) / "telegram-transcriptor"


# ============================================================================
# CONVERSATION STATE (per gestionar idioma per usuari)
# ============================================================================

class ConversationState:
    """Gestiona l'estat de conversa per usuari (idioma preferit)"""

    def __init__(self, state_file: Path):
        self.state_file = state_file
        self.users: Dict[str, Dict] = {}
        self._load()

    def _load(self):
        """Carrega estat des de fitxer"""
        try:
            if self.state_file.exists():
                with open(self.state_file, 'r') as f:
                    data = json.load(f)
                    self.users = data.get('users', {})
        except Exception as e:
            log.warning(f"Could not load state: {e}")
            self.users = {}

    def _save(self):
        """Guarda estat a fitxer"""
        try:
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            with open(self.state_file, 'w') as f:
                json.dump({'users': self.users}, f)
        except Exception as e:
            log.warning(f"Could not save state: {e}")

    def get_language(self, user_id: str) -> Optional[str]:
        """Obté l'idioma preferit d'un usuari"""
        return self.users.get(user_id, {}).get('language')

    def set_language(self, user_id: str, language: str):
        """Estableix l'idioma preferit d'un usuari"""
        if user_id not in self.users:
            self.users[user_id] = {}
        self.users[user_id]['language'] = language
        self._save()
        log.info(f"Language for user {user_id} set to: {language}")


# ============================================================================
# VOICE SERVICE (Whisper STT + Piper TTS)
# ============================================================================

class VoiceService:
    """Servei de transcripció i síntesi de veu"""

    def __init__(self, config: Dict):
        self.config = config
        self.state = ConversationState(STATE_PATH)

        # Paths de Whisper
        self.whisper_path = Path(config.get('whisperPath', '')).expanduser()
        self.model_path = Path(config.get('modelPath', '')).expanduser()
        self.threads = config.get('threads', 4)

        # Paths de Piper
        self.piper_path = Path(config.get('piperPath', '')).expanduser()
        self.voices_dir = Path(config.get('voicesDir', '')).expanduser()
        self.default_voice = Path(config.get('voicePath', '')).expanduser()
        self.length_scale = config.get('lengthScale', 0.85)

        # Idiomes suportats
        self.supported_languages = ['ca', 'es', 'en']
        self.default_language = config.get('defaultLanguage', 'ca')

        # Veus per idioma
        self.voices = {
            'ca': self.voices_dir / 'ca_ES-upc_pau-x_low.onnx',
            'es': self.voices_dir / 'es_ES-sharvard-medium.onnx',
            'en': self.voices_dir / 'en_US-lessac-medium.onnx',
        }

        # Verificar paths
        self._verify_paths()

        log.info("VoiceService initialized")
        log.info(f"  Whisper: {self.whisper_path}")
        log.info(f"  Piper: {self.piper_path}")
        log.info(f"  Default language: {self.default_language}")

    def _verify_paths(self):
        """Verifica que els paths existeixen"""
        if not self.whisper_path.exists():
            log.warning(f"Whisper not found at {self.whisper_path}")
        if not self.model_path.exists():
            log.warning(f"Whisper model not found at {self.model_path}")
        if not self.piper_path.exists():
            log.warning(f"Piper not found at {self.piper_path}")

    async def transcribe(
        self,
        audio_path: str,
        language: Optional[str] = None,
        user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Transcriu àudio a text amb Whisper

        Args:
            audio_path: Path al fitxer d'àudio
            language: Idioma forçat (ca, es, en) o None per auto-detect
            user_id: ID d'usuari per guardar preferència d'idioma

        Returns:
            {"text": str, "language": str}
        """
        audio_path = Path(audio_path).expanduser()
        if not audio_path.exists():
            return {"error": f"Audio file not found: {audio_path}"}

        # Convert to WAV if needed (Whisper requires WAV format)
        if audio_path.suffix.lower() in ['.ogg', '.opus', '.mp3', '.m4a', '.webm']:
            wav_path = TMP_DIR / f"converted_{audio_path.stem}_{int(datetime.now().timestamp())}.wav"
            try:
                convert_cmd = [
                    'ffmpeg', '-y', '-i', str(audio_path),
                    '-ar', '16000', '-ac', '1', str(wav_path)
                ]
                proc = await asyncio.create_subprocess_exec(
                    *convert_cmd,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL
                )
                await proc.wait()
                if wav_path.exists():
                    audio_path = wav_path
                    log.info(f"  Converted to WAV: {wav_path}")
            except Exception as e:
                log.warning(f"  Could not convert audio: {e}")

        # Construir comanda Whisper
        cmd = [
            str(self.whisper_path),
            '-m', str(self.model_path),
            '-f', str(audio_path),
            '-t', str(self.threads),
            '--no-timestamps',
            '-np',  # No progress
        ]

        # Idioma
        if language and language in self.supported_languages:
            cmd.extend(['-l', language])
            log.info(f"  Language forced: {language}")
        elif user_id and self.state.get_language(user_id):
            saved_lang = self.state.get_language(user_id)
            cmd.extend(['-l', saved_lang])
            log.info(f"  Language from user preference: {saved_lang}")
        else:
            # Auto-detect
            cmd.append('--detect-language')
            log.info("  Language detection: auto")

        log.info(f"Transcribing {audio_path}")

        try:
            # Executar Whisper
            result = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await result.communicate()

            if result.returncode != 0:
                error_msg = stderr.decode().strip()
                log.error(f"Whisper error: {error_msg}")
                return {"error": f"Transcription failed: {error_msg}"}

            # Parsejar resultat
            text = stdout.decode().strip()

            # Detectar idioma del output si es va auto-detectar
            detected_lang = None
            for line in stderr.decode().split('\n'):
                if 'detected language:' in line.lower():
                    # Format: "whisper_full_with_state: detected language: en"
                    parts = line.split(':')
                    if len(parts) >= 2:
                        detected_lang = parts[-1].strip().lower()[:2]
                        break

            # Si no es va forçar idioma i es va detectar, guardar preferència
            if not language and detected_lang and user_id:
                log.info(f"  Detected language: {detected_lang}")
                self.state.set_language(user_id, detected_lang)

            final_lang = language or detected_lang or self.default_language

            return {
                "text": text,
                "language": final_lang
            }

        except Exception as e:
            log.error(f"Transcription error: {e}")
            return {"error": str(e)}

    async def synthesize(
        self,
        text: str,
        language: Optional[str] = None,
        output_path: Optional[str] = None,
        user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Sintetitza text a veu amb Piper

        Args:
            text: Text a sintetitzar
            language: Idioma (ca, es, en)
            output_path: Path de sortida (opcional, genera temporal si no es dóna)
            user_id: ID d'usuari per obtenir preferència d'idioma

        Returns:
            {"audio_path": str, "language": str}
        """
        if not text or not text.strip():
            return {"error": "Empty text"}

        # Clean text for TTS (remove emojis and special characters)
        import re
        # Remove emojis
        emoji_pattern = re.compile("["
            u"\U0001F600-\U0001F64F"  # emoticons
            u"\U0001F300-\U0001F5FF"  # symbols & pictographs
            u"\U0001F680-\U0001F6FF"  # transport & map symbols
            u"\U0001F1E0-\U0001F1FF"  # flags
            u"\U00002702-\U000027B0"  # dingbats
            u"\U000024C2-\U0001F251"  # enclosed characters
            u"\U0001F900-\U0001F9FF"  # supplemental symbols
            u"\U0001FA00-\U0001FA6F"  # chess symbols
            u"\U0001FA70-\U0001FAFF"  # symbols extended
            u"\U00002600-\U000026FF"  # misc symbols
            "]+", flags=re.UNICODE)
        text = emoji_pattern.sub('', text)
        # Remove markdown formatting
        text = re.sub(r'\*\*([^*]+)\*\*', r'\1', text)  # **bold**
        text = re.sub(r'\*([^*]+)\*', r'\1', text)      # *italic*
        text = re.sub(r'__([^_]+)__', r'\1', text)      # __underline__
        text = re.sub(r'~~([^~]+)~~', r'\1', text)      # ~~strike~~
        # Clean up extra whitespace
        text = re.sub(r'\s+', ' ', text).strip()
        
        if not text:
            return {"error": "Text empty after cleaning"}

        # Determinar idioma
        if not language:
            if user_id:
                language = self.state.get_language(user_id)
            if not language:
                language = self.default_language

        # Seleccionar veu
        voice_path = self.voices.get(language, self.default_voice)
        if not voice_path.exists():
            log.warning(f"Voice not found for {language}, using default")
            voice_path = self.default_voice

        # Generar path de sortida si no es dóna
        if not output_path:
            TMP_DIR.mkdir(parents=True, exist_ok=True)
            output_path = TMP_DIR / f"tts_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}.wav"
        else:
            output_path = Path(output_path).expanduser()

        log.info(f"Synthesizing: '{text[:50]}...' ({language})")

        try:
            # Executar Piper
            cmd = [
                str(self.piper_path),
                '--model', str(voice_path),
                '--output_file', str(output_path),
                '--length_scale', str(self.length_scale),
            ]

            # Afegir LD_LIBRARY_PATH per Linux
            env = os.environ.copy()
            if platform.system() == "Linux":
                piper_dir = self.piper_path.parent
                env['LD_LIBRARY_PATH'] = f"{piper_dir}:{env.get('LD_LIBRARY_PATH', '')}"

            result = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env
            )

            stdout, stderr = await result.communicate(input=text.encode())

            if result.returncode != 0:
                error_msg = stderr.decode().strip()
                log.error(f"Piper error: {error_msg}")
                return {"error": f"Synthesis failed: {error_msg}"}

            if not output_path.exists():
                return {"error": "Output file not created"}

            # Convert WAV to OGG/Opus for Telegram compatibility
            ogg_path = output_path.with_suffix('.ogg')
            try:
                convert_cmd = [
                    'ffmpeg', '-y', '-i', str(output_path),
                    '-c:a', 'libopus', '-b:a', '64k',
                    '-metadata', 'title=Jarvis',
                    '-metadata', 'artist=Jarvis AI',
                    str(ogg_path)
                ]
                proc = await asyncio.create_subprocess_exec(
                    *convert_cmd,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL
                )
                await proc.wait()
                if ogg_path.exists():
                    # Remove original WAV
                    output_path.unlink(missing_ok=True)
                    output_path = ogg_path
                    log.info(f"  Converted to OGG: {ogg_path}")
            except Exception as e:
                log.warning(f"  Could not convert to OGG: {e}, using WAV")

            return {
                "audio_path": str(output_path),
                "language": language
            }

        except Exception as e:
            log.error(f"Synthesis error: {e}")
            return {"error": str(e)}

    def get_status(self) -> Dict[str, Any]:
        """Retorna l'estat del servei"""
        return {
            "status": "ok",  # Required for voice-client compatibility
            "service": "transcriptor",
            "version": VERSION,
            "transport": TRANSPORT,
            "socket": SOCKET_PATH if TRANSPORT == "unix" else f"{TCP_HOST}:{TCP_PORT}",
            "whisper_available": self.whisper_path.exists(),
            "piper_available": self.piper_path.exists(),
            "supported_languages": self.supported_languages,
            "default_language": self.default_language,
        }


# ============================================================================
# JSON-RPC SERVER
# ============================================================================

class JSONRPCServer:
    """Servidor JSON-RPC per exposar el servei de transcripció"""

    def __init__(self, voice_service: VoiceService):
        self.voice_service = voice_service
        self.clients = set()

    async def handle_request(self, request: Dict) -> Dict:
        """Processa una petició JSON-RPC"""
        method = request.get('method')
        params = request.get('params', {})
        request_id = request.get('id')

        try:
            if method == 'transcribe':
                result = await self.voice_service.transcribe(
                    audio_path=params.get('audio_path'),
                    language=params.get('language'),
                    user_id=params.get('user_id')
                )
            elif method == 'synthesize':
                result = await self.voice_service.synthesize(
                    text=params.get('text'),
                    language=params.get('language'),
                    output_path=params.get('output_path'),
                    user_id=params.get('user_id')
                )
            elif method == 'status':
                result = self.voice_service.get_status()
            elif method == 'health':
                # Health check - returns status: ok if service is healthy
                result = {"status": "ok", "service": "transcriptor", "version": VERSION}
            elif method == 'set_language':
                user_id = params.get('user_id')
                language = params.get('language')
                if user_id and language:
                    self.voice_service.state.set_language(user_id, language)
                    result = {"status": "ok"}
                else:
                    result = {"error": "Missing user_id or language"}
            elif method == 'get_language':
                user_id = params.get('user_id')
                if user_id:
                    lang = self.voice_service.state.get_language(user_id)
                    result = {"language": lang}
                else:
                    result = {"error": "Missing user_id"}
            else:
                result = {"error": f"Unknown method: {method}"}

            return {
                "jsonrpc": "2.0",
                "result": result,
                "id": request_id
            }

        except Exception as e:
            log.error(f"Error handling {method}: {e}")
            return {
                "jsonrpc": "2.0",
                "error": {"code": -32000, "message": str(e)},
                "id": request_id
            }


# ============================================================================
# SERVER HANDLERS
# ============================================================================

async def handle_client(reader, writer, rpc_server: JSONRPCServer):
    """Gestiona una connexió de client"""
    addr = writer.get_extra_info('peername') or "unix"
    log.info(f"Client connected: {addr}")
    rpc_server.clients.add(writer)

    try:
        while True:
            # Llegir longitud del missatge (4 bytes, big-endian)
            length_bytes = await reader.readexactly(4)
            length = int.from_bytes(length_bytes, 'big')

            # Llegir missatge
            data = await reader.readexactly(length)
            request = json.loads(data.decode())

            # Processar
            response = await rpc_server.handle_request(request)

            # Enviar resposta
            response_data = json.dumps(response).encode()
            writer.write(len(response_data).to_bytes(4, 'big'))
            writer.write(response_data)
            await writer.drain()

    except asyncio.IncompleteReadError:
        pass  # Client disconnected
    except Exception as e:
        log.error(f"Client error: {e}")
    finally:
        rpc_server.clients.discard(writer)
        writer.close()
        try:
            await writer.wait_closed()
        except:
            pass
        log.info(f"Client disconnected: {addr}")


async def start_unix_server(rpc_server: JSONRPCServer):
    """Inicia servidor Unix socket"""
    # Eliminar socket antic si existeix
    socket_path = Path(SOCKET_PATH)
    if socket_path.exists():
        socket_path.unlink()

    server = await asyncio.start_unix_server(
        lambda r, w: handle_client(r, w, rpc_server),
        path=SOCKET_PATH
    )

    # Permisos
    os.chmod(SOCKET_PATH, 0o600)

    log.info(f"🚀 Listening on Unix socket: {SOCKET_PATH}")
    return server


async def start_tcp_server(rpc_server: JSONRPCServer):
    """Inicia servidor TCP (per macOS)"""
    server = await asyncio.start_server(
        lambda r, w: handle_client(r, w, rpc_server),
        host=TCP_HOST,
        port=TCP_PORT
    )

    log.info(f"🚀 Listening on TCP: {TCP_HOST}:{TCP_PORT}")
    return server


# ============================================================================
# MAIN
# ============================================================================

async def main():
    """Punt d'entrada principal"""

    log.info(f"🎤 Telegram Transcriptor Service v{VERSION}")
    log.info(f"   Platform: {platform.system()}")
    log.info(f"   Transport: {TRANSPORT}")

    # Crear directori temporal
    TMP_DIR.mkdir(parents=True, exist_ok=True)

    # Carregar configuració
    config = {}
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH, 'r') as f:
            config = json.load(f)

    # Crear servei de veu
    voice_service = VoiceService(config)

    # Crear servidor JSON-RPC
    rpc_server = JSONRPCServer(voice_service)

    # Iniciar servidor segons plataforma
    if TRANSPORT == "unix":
        server = await start_unix_server(rpc_server)
    else:
        server = await start_tcp_server(rpc_server)

    # Gestionar senyals
    loop = asyncio.get_event_loop()

    async def shutdown_handler():
        log.info("Shutting down...")
        server.close()
        await server.wait_closed()

        # Tancar clients
        for writer in list(rpc_server.clients):
            writer.close()

        # Netejar socket
        if TRANSPORT == "unix" and Path(SOCKET_PATH).exists():
            Path(SOCKET_PATH).unlink()

    def signal_handler(sig):
        log.info(f"Received signal {sig}")
        asyncio.create_task(shutdown_handler())

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, lambda s=sig: signal_handler(s))

    # Servir
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
