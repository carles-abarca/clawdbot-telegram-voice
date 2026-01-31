#!/usr/bin/env python3
"""
Telegram Voice Service for Clawdbot

Servei independent que gestiona:
- Notes de veu (STT/TTS)
- Trucades de veu (futur)

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
SERVICE_NAME = "telegram-voice"
VERSION = "1.0.0"

# Paths segons plataforma
if platform.system() == "Linux":
    SOCKET_PATH = f"/run/user/{os.getuid()}/{SERVICE_NAME}.sock"
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
TMP_DIR = Path(tempfile.gettempdir()) / "telegram-voice"


class ConversationState:
    """Gestiona l'estat d'idioma per conversa"""
    
    def __init__(self, state_path: Path):
        self.state_path = state_path
        self.state = self._load()
    
    def _load(self) -> Dict:
        if self.state_path.exists():
            try:
                return json.loads(self.state_path.read_text())
            except:
                pass
        return {"users": {}, "defaults": {"language": "ca"}}
    
    def _save(self):
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(json.dumps(self.state, indent=2))
    
    def get_language(self, user_id: str) -> str:
        return self.state["users"].get(str(user_id), {}).get(
            "language", self.state["defaults"]["language"]
        )
    
    def set_language(self, user_id: str, language: str):
        self.state["users"][str(user_id)] = {
            "language": language,
            "lastUpdated": datetime.now().isoformat()
        }
        self._save()
        log.info(f"Language for user {user_id} set to: {language}")


class VoiceService:
    """Servei principal de veu"""
    
    SUPPORTED_LANGUAGES = {
        "ca": {"name": "Català", "whisper": "ca", "voice": "ca_ES-upc_pau-x_low.onnx"},
        "es": {"name": "Castellà", "whisper": "es", "voice": "es_ES-sharvard-medium.onnx"},
        "en": {"name": "English", "whisper": "en", "voice": "en_US-lessac-medium.onnx"},
    }
    
    def __init__(self, config: Dict):
        self.config = config
        self.state = ConversationState(STATE_PATH)
        self.tmp_dir = TMP_DIR
        self.tmp_dir.mkdir(parents=True, exist_ok=True)
        
        # Paths de les eines
        self.whisper_path = self._expand_path(config.get("whisperPath", ""))
        self.whisper_model = self._expand_path(config.get("modelPath", ""))
        self.piper_path = self._expand_path(config.get("piperPath", ""))
        self.voices_dir = self._expand_path(config.get("voicesDir", "~/piper/voices"))
        self.default_voice = self._expand_path(config.get("voicePath", ""))
        self.threads = config.get("threads", 4)
        self.length_scale = config.get("lengthScale", 0.85)
        
        log.info(f"VoiceService initialized")
        log.info(f"  Whisper: {self.whisper_path}")
        log.info(f"  Piper: {self.piper_path}")
        log.info(f"  Default language: {self.state.state['defaults']['language']}")
    
    def _expand_path(self, p: str) -> str:
        if not p:
            return ""
        return os.path.expanduser(os.path.expandvars(p))
    
    async def transcribe(self, audio_path: str, user_id: Optional[str] = None, force_language: Optional[str] = None) -> Dict:
        """Transcriu àudio a text amb detecció automàtica d'idioma"""
        
        log.info(f"Transcribing {audio_path} (auto-detect language)")
        
        # Convertir a WAV si cal
        wav_path = await self._ensure_wav(audio_path)
        
        # Executar Whisper SENSE forçar idioma (detecció automàtica)
        output_base = str(self.tmp_dir / f"transcript_{os.getpid()}")
        cmd = [
            self.whisper_path,
            "-m", self.whisper_model,
            "-f", wav_path,
            # NO forcem -l per permetre detecció automàtica
            "-t", str(self.threads),
            "-otxt",
            "-of", output_base,
            "--no-timestamps",
            "--print-special"  # Per veure l'idioma detectat
        ]
        
        # Si es força un idioma específic, usar-lo
        if force_language:
            lang_code = self.SUPPORTED_LANGUAGES.get(force_language, {}).get("whisper", force_language)
            cmd.extend(["-l", lang_code])
            log.info(f"  Forced language: {lang_code}")
        
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await proc.communicate()
            
            if proc.returncode != 0:
                log.error(f"Whisper error: {stderr.decode()}")
                return {"error": "Transcription failed", "details": stderr.decode()}
            
            # Llegir resultat
            txt_path = output_base + ".txt"
            if os.path.exists(txt_path):
                text = Path(txt_path).read_text().strip()
                os.unlink(txt_path)
            else:
                text = stdout.decode().strip()
            
            # Detectar idioma des de la sortida de Whisper
            detected_language = self._detect_language_from_output(stderr.decode(), text)
            log.info(f"  Detected language: {detected_language}")
            
            # Guardar l'idioma detectat per aquest usuari (per la resposta TTS)
            if user_id and detected_language:
                self.state.set_language(str(user_id), detected_language)
            
            return {
                "text": text,
                "language": detected_language,
                "audio_path": audio_path
            }
            
        except Exception as e:
            log.error(f"Transcription error: {e}")
            return {"error": str(e)}
    
    async def synthesize(self, text: str, user_id: Optional[str] = None) -> Dict:
        """Genera àudio des de text"""
        language = self.state.get_language(user_id) if user_id else "ca"
        voice_file = self.SUPPORTED_LANGUAGES.get(language, {}).get("voice")
        
        if voice_file:
            voice_path = os.path.join(self.voices_dir, voice_file)
        else:
            voice_path = self.default_voice
        
        log.info(f"Synthesizing text with voice={voice_path}")
        
        # Generar àudio
        output_path = str(self.tmp_dir / f"tts_{os.getpid()}_{datetime.now().timestamp()}.wav")
        
        cmd = [
            self.piper_path,
            "--model", voice_path,
            "--output_file", output_path,
            "--length_scale", str(self.length_scale)
        ]
        
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env={**os.environ, "LD_LIBRARY_PATH": str(Path(self.piper_path).parent)}
            )
            stdout, stderr = await proc.communicate(input=text.encode())
            
            if proc.returncode != 0:
                log.error(f"Piper error: {stderr.decode()}")
                return {"error": "Synthesis failed", "details": stderr.decode()}
            
            return {
                "audio_path": output_path,
                "language": language,
                "text": text
            }
            
        except Exception as e:
            log.error(f"Synthesis error: {e}")
            return {"error": str(e)}
    
    async def set_language(self, user_id: str, language: str) -> Dict:
        """Canvia l'idioma per un usuari"""
        if language not in self.SUPPORTED_LANGUAGES:
            return {"error": f"Unsupported language: {language}. Supported: {list(self.SUPPORTED_LANGUAGES.keys())}"}
        
        self.state.set_language(user_id, language)
        return {
            "user_id": user_id,
            "language": language,
            "language_name": self.SUPPORTED_LANGUAGES[language]["name"]
        }
    
    async def get_language(self, user_id: str) -> Dict:
        """Obté l'idioma actual per un usuari"""
        language = self.state.get_language(user_id)
        return {
            "user_id": user_id,
            "language": language,
            "language_name": self.SUPPORTED_LANGUAGES.get(language, {}).get("name", language)
        }
    
    async def get_status(self) -> Dict:
        """Retorna l'estat del servei"""
        return {
            "service": SERVICE_NAME,
            "version": VERSION,
            "transport": TRANSPORT,
            "socket": SOCKET_PATH if TRANSPORT == "unix" else f"{TCP_HOST}:{TCP_PORT}",
            "whisper_available": os.path.exists(self.whisper_path),
            "piper_available": os.path.exists(self.piper_path),
            "supported_languages": list(self.SUPPORTED_LANGUAGES.keys()),
            "default_language": self.state.state["defaults"]["language"],
            "active_users": len(self.state.state["users"])
        }
    
    def _detect_language_from_output(self, stderr: str, text: str) -> str:
        """Detecta l'idioma des de la sortida de Whisper o del text"""
        import re
        
        # Whisper pot indicar l'idioma a stderr amb "auto-detected language: xx"
        lang_match = re.search(r'auto-detected language[:\s]+(\w+)', stderr, re.IGNORECASE)
        if lang_match:
            detected = lang_match.group(1).lower()
            # Mappejar codis de Whisper als nostres codis
            lang_map = {"spanish": "es", "catalan": "ca", "english": "en", 
                       "es": "es", "ca": "ca", "en": "en"}
            if detected in lang_map:
                return lang_map[detected]
        
        # Fallback: heurística basada en el text
        if text:
            text_lower = text.lower()
            # Paraules típiques espanyoles (no catalanes)
            spanish_markers = ["¿", "está", "estás", "qué", "cómo", "dónde", "cuándo", 
                             "tengo", "tienes", "tiene", "puedo", "puedes", "puede",
                             "quiero", "quieres", "necesito", "algún", "alguna"]
            # Paraules típiques catalanes
            catalan_markers = ["què", "com", "on", "quan", "tinc", "tens", "té",
                              "puc", "pots", "pot", "vull", "vols", "vol", 
                              "necessito", "algun", "alguna", "però", "això"]
            # Paraules típiques angleses
            english_markers = ["the", "what", "how", "where", "when", "have", "has",
                              "can", "could", "want", "need", "some", "any"]
            
            spanish_count = sum(1 for m in spanish_markers if m in text_lower)
            catalan_count = sum(1 for m in catalan_markers if m in text_lower)
            english_count = sum(1 for m in english_markers if m in text_lower)
            
            if spanish_count > catalan_count and spanish_count > english_count:
                return "es"
            elif catalan_count > spanish_count and catalan_count > english_count:
                return "ca"
            elif english_count > 0:
                return "en"
        
        # Default: espanyol si no podem determinar (més comú a Monterrey)
        return "es"
    
    async def _ensure_wav(self, audio_path: str) -> str:
        """Converteix a WAV si cal (opus, ogg, etc.)"""
        if audio_path.endswith(".wav"):
            return audio_path
        
        wav_path = str(self.tmp_dir / f"converted_{os.getpid()}.wav")
        cmd = ["ffmpeg", "-y", "-i", audio_path, "-ar", "16000", "-ac", "1", wav_path]
        
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL
        )
        await proc.communicate()
        
        return wav_path if os.path.exists(wav_path) else audio_path


class JSONRPCServer:
    """Servidor JSON-RPC"""
    
    def __init__(self, voice_service: VoiceService):
        self.voice = voice_service
        self.methods = {
            "transcribe": self._handle_transcribe,
            "synthesize": self._handle_synthesize,
            "language.set": self._handle_set_language,
            "language.get": self._handle_get_language,
            "status": self._handle_status,
            "health": self._handle_health,
        }
    
    async def handle_request(self, data: bytes) -> bytes:
        """Processa una request JSON-RPC"""
        try:
            request = json.loads(data.decode())
        except json.JSONDecodeError:
            return self._error_response(None, -32700, "Parse error")
        
        # Batch request
        if isinstance(request, list):
            responses = [await self._process_single(r) for r in request]
            return json.dumps(responses).encode()
        
        return await self._process_single(request)
    
    async def _process_single(self, request: Dict) -> bytes:
        """Processa una sola request"""
        req_id = request.get("id")
        method = request.get("method")
        params = request.get("params", {})
        
        if method not in self.methods:
            return self._error_response(req_id, -32601, f"Method not found: {method}")
        
        try:
            result = await self.methods[method](params)
            return self._success_response(req_id, result)
        except Exception as e:
            log.error(f"Error handling {method}: {e}")
            return self._error_response(req_id, -32000, str(e))
    
    async def _handle_transcribe(self, params: Dict) -> Dict:
        audio_path = params.get("audio_path")
        user_id = params.get("user_id")
        if not audio_path:
            raise ValueError("audio_path required")
        return await self.voice.transcribe(audio_path, user_id)
    
    async def _handle_synthesize(self, params: Dict) -> Dict:
        text = params.get("text")
        user_id = params.get("user_id")
        if not text:
            raise ValueError("text required")
        return await self.voice.synthesize(text, user_id)
    
    async def _handle_set_language(self, params: Dict) -> Dict:
        user_id = params.get("user_id")
        language = params.get("language")
        if not user_id or not language:
            raise ValueError("user_id and language required")
        return await self.voice.set_language(str(user_id), language)
    
    async def _handle_get_language(self, params: Dict) -> Dict:
        user_id = params.get("user_id")
        if not user_id:
            raise ValueError("user_id required")
        return await self.voice.get_language(str(user_id))
    
    async def _handle_status(self, params: Dict) -> Dict:
        return await self.voice.get_status()
    
    async def _handle_health(self, params: Dict) -> Dict:
        return {"status": "ok", "timestamp": datetime.now().isoformat()}
    
    def _success_response(self, req_id, result) -> bytes:
        return json.dumps({
            "jsonrpc": "2.0",
            "result": result,
            "id": req_id
        }).encode()
    
    def _error_response(self, req_id, code: int, message: str) -> bytes:
        return json.dumps({
            "jsonrpc": "2.0",
            "error": {"code": code, "message": message},
            "id": req_id
        }).encode()


async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, server: JSONRPCServer):
    """Gestiona una connexió de client"""
    addr = writer.get_extra_info('peername')
    log.info(f"Client connected: {addr}")
    
    try:
        while True:
            # Llegir longitud del missatge (4 bytes, big-endian)
            length_bytes = await reader.read(4)
            if not length_bytes:
                break
            
            length = int.from_bytes(length_bytes, 'big')
            if length > 10 * 1024 * 1024:  # Max 10MB
                log.warning(f"Message too large: {length}")
                break
            
            # Llegir missatge
            data = await reader.read(length)
            if not data:
                break
            
            # Processar i respondre
            response = await server.handle_request(data)
            
            # Enviar resposta amb longitud
            writer.write(len(response).to_bytes(4, 'big'))
            writer.write(response)
            await writer.drain()
            
    except asyncio.CancelledError:
        pass
    except Exception as e:
        log.error(f"Client error: {e}")
    finally:
        writer.close()
        await writer.wait_closed()
        log.info(f"Client disconnected: {addr}")


async def start_unix_server(server: JSONRPCServer):
    """Inicia servidor Unix socket (Linux)"""
    # Eliminar socket antic si existeix
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)
    
    # Crear directori si cal
    os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)
    
    srv = await asyncio.start_unix_server(
        lambda r, w: handle_client(r, w, server),
        path=SOCKET_PATH
    )
    
    # Permisos restrictius
    os.chmod(SOCKET_PATH, 0o600)
    
    log.info(f"🚀 Listening on Unix socket: {SOCKET_PATH}")
    return srv


async def start_tcp_server(server: JSONRPCServer):
    """Inicia servidor TCP (macOS)"""
    srv = await asyncio.start_server(
        lambda r, w: handle_client(r, w, server),
        host=TCP_HOST,
        port=TCP_PORT
    )
    
    log.info(f"🚀 Listening on TCP: {TCP_HOST}:{TCP_PORT}")
    return srv


def load_config() -> Dict:
    """Carrega configuració"""
    # Primer intentar carregar config específica del servei
    if CONFIG_PATH.exists():
        return json.loads(CONFIG_PATH.read_text())
    
    # Sinó, llegir de la config de Clawdbot
    clawdbot_config = Path.home() / ".clawdbot" / "clawdbot.json"
    if clawdbot_config.exists():
        config = json.loads(clawdbot_config.read_text())
        userbot_config = config.get("channels", {}).get("telegram-userbot", {})
        return {
            **userbot_config.get("stt", {}),
            **userbot_config.get("tts", {}),
            "voicesDir": "~/piper/voices"
        }
    
    # Config per defecte
    return {
        "whisperPath": "~/whisper.cpp/build/bin/whisper-cli",
        "modelPath": "~/whisper.cpp/models/ggml-small.bin",
        "piperPath": "~/piper/piper/piper",
        "voicesDir": "~/piper/voices",
        "voicePath": "~/piper/voices/ca_ES-upc_pau-x_low.onnx",
        "threads": 4,
        "lengthScale": 0.85
    }


async def main():
    """Entry point"""
    log.info(f"🎤 Telegram Voice Service v{VERSION}")
    log.info(f"   Platform: {platform.system()}")
    log.info(f"   Transport: {TRANSPORT}")
    
    # Carregar configuració
    config = load_config()
    
    # Inicialitzar servei
    voice_service = VoiceService(config)
    rpc_server = JSONRPCServer(voice_service)
    
    # Iniciar servidor segons plataforma
    if TRANSPORT == "unix":
        server = await start_unix_server(rpc_server)
    else:
        server = await start_tcp_server(rpc_server)
    
    # Gestionar senyals
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: asyncio.create_task(shutdown(server)))
    
    # Córrer fins que s'aturi
    async with server:
        await server.serve_forever()


async def shutdown(server):
    """Atura el servidor"""
    log.info("👋 Shutting down...")
    server.close()
    await server.wait_closed()
    
    # Netejar socket
    if TRANSPORT == "unix" and os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Interrupted")
