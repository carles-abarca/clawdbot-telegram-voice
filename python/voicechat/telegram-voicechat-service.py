#!/usr/bin/env python3
"""
Telegram Voice Chat Streaming Service for Clawdbot

Servei independent que gestiona:
- Voice Chats (grups) amb streaming bidireccional
- Trucades P2P amb auto-answer
- STT amb whisper.cpp
- TTS amb Piper

Exposa API JSON-RPC via Unix Socket
"""

import asyncio
import json
import os
import sys
import signal
import tempfile
import subprocess
import platform
import struct
from io import BytesIO
from pathlib import Path
from datetime import datetime
from typing import Optional, Dict, Any, Union, List, Callable
import logging
import threading
import queue
import time

# Hydrogram/Pyrogram per MTProto
try:
    from hydrogram import Client
    from hydrogram import filters as pyro_filters
    PYROGRAM_AVAILABLE = True
    MTPROTO_CLIENT = "hydrogram"
except ImportError:
    try:
        from pyrogram import Client
        from pyrogram import filters as pyro_filters
        PYROGRAM_AVAILABLE = True
        MTPROTO_CLIENT = "pyrogram"
    except ImportError:
        PYROGRAM_AVAILABLE = False
        MTPROTO_CLIENT = None
        logging.warning("No MTProto client available")

# pytgcalls per Voice Chats
try:
    from pytgcalls import PyTgCalls
    from pytgcalls import filters as ptg_filters
    from pytgcalls import idle
    from pytgcalls.types import AudioQuality, Device, Direction
    from pytgcalls.types import RecordStream, MediaStream, ExternalMedia
    from pytgcalls.types import ChatUpdate, StreamFrames
    from pytgcalls.types.raw import AudioParameters
    PYTGCALLS_AVAILABLE = True
except ImportError:
    PYTGCALLS_AVAILABLE = False
    logging.warning("pytgcalls not available")

# Numpy per processament d'àudio
try:
    import numpy as np
    NUMPY_AVAILABLE = True
except ImportError:
    NUMPY_AVAILABLE = False
    logging.warning("numpy not available")

# Configuració de logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
log = logging.getLogger(__name__)

# Constants
SERVICE_NAME = "telegram-voicechat"
VERSION = "1.0.0"

# Paths
SOCKET_PATH = f"/run/user/{os.getuid()}/{SERVICE_NAME}.sock"
BASE_DIR = Path.home() / ".clawdbot" / "telegram-userbot"
CONFIG_PATH = BASE_DIR / "voicechat-config.json"
SESSION_PATH = BASE_DIR / "session-voicechat"  # Sessió separada per evitar locks
TMP_DIR = Path(tempfile.gettempdir()) / SERVICE_NAME

# Àudio settings
SAMPLE_RATE = 48000
CHANNELS = 2
AUDIO_QUALITY = AudioQuality.HIGH if PYTGCALLS_AVAILABLE else None


class AudioBuffer:
    """Buffer circular per àudio amb detecció de silenci"""
    
    def __init__(
        self,
        sample_rate: int = SAMPLE_RATE,
        channels: int = CHANNELS,
        silence_threshold: float = 0.01,
        silence_duration: float = 1.5,  # segons de silenci per acabar
        max_duration: float = 30.0,  # màxim temps de gravació
    ):
        self.sample_rate = sample_rate
        self.channels = channels
        self.silence_threshold = silence_threshold
        self.silence_duration = silence_duration
        self.max_duration = max_duration
        
        self.buffer = BytesIO()
        self.silent_samples = 0
        self.total_samples = 0
        self.has_speech = False
        self.lock = threading.Lock()
    
    def add_frame(self, data: bytes) -> Optional[bytes]:
        """Afegeix un frame i retorna l'àudio complet si detecta fi de frase"""
        with self.lock:
            is_silent = self._is_silent(data)
            frame_samples = len(data) // (2 * self.channels)
            
            self.buffer.write(data)
            self.total_samples += frame_samples
            
            if is_silent:
                self.silent_samples += frame_samples
            else:
                self.silent_samples = 0
                self.has_speech = True
            
            # Calcular durades
            silence_samples_threshold = int(self.sample_rate * self.silence_duration)
            max_samples = int(self.sample_rate * self.max_duration)
            
            # Retornar si: té speech + prou silenci, o màxim temps
            should_return = (
                (self.has_speech and self.silent_samples >= silence_samples_threshold) or
                (self.total_samples >= max_samples)
            )
            
            if should_return:
                return self._flush()
            
            return None
    
    def _is_silent(self, data: bytes) -> bool:
        """Detecta si un frame és silenci"""
        if not NUMPY_AVAILABLE:
            return False
        
        try:
            buffer = np.frombuffer(data, dtype=np.int16)
            if self.channels > 1:
                buffer = buffer.reshape(-1, self.channels).mean(axis=1)
            buffer = buffer.astype(np.float32) / np.iinfo(np.int16).max
            rms = np.sqrt(np.mean(np.square(buffer)))
            return rms < self.silence_threshold
        except Exception:
            return False
    
    def _flush(self) -> bytes:
        """Buida el buffer i retorna l'àudio"""
        self.buffer.seek(0)
        data = self.buffer.getvalue()
        self.buffer = BytesIO()
        self.silent_samples = 0
        self.total_samples = 0
        self.has_speech = False
        return data
    
    def clear(self):
        """Neteja el buffer"""
        with self.lock:
            self.buffer = BytesIO()
            self.silent_samples = 0
            self.total_samples = 0
            self.has_speech = False


class STTProcessor:
    """Processador STT amb whisper.cpp"""
    
    def __init__(self, config: Dict):
        self.whisper_path = self._expand(config.get("whisperPath", ""))
        self.model_path = self._expand(config.get("modelPath", ""))
        self.threads = config.get("threads", 4)
        self.tmp_dir = TMP_DIR
        self.tmp_dir.mkdir(parents=True, exist_ok=True)
        
        log.info(f"STT initialized: {self.whisper_path}")
    
    def _expand(self, p: str) -> str:
        return os.path.expanduser(os.path.expandvars(p)) if p else ""
    
    def _pcm_to_wav(self, pcm_data: bytes, sample_rate: int = SAMPLE_RATE, channels: int = CHANNELS) -> bytes:
        """Converteix PCM16 a WAV"""
        byte_rate = sample_rate * channels * 2
        block_align = channels * 2
        sub_chunk2_size = len(pcm_data)
        chunk_size = 36 + sub_chunk2_size
        
        wav_header = struct.pack(
            '<4sI4s4sIHHIIHH4sI',
            b'RIFF',
            chunk_size,
            b'WAVE',
            b'fmt ',
            16,
            1,  # PCM
            channels,
            sample_rate,
            byte_rate,
            block_align,
            16,  # bits per sample
            b'data',
            sub_chunk2_size,
        )
        return wav_header + pcm_data
    
    async def transcribe(self, pcm_data: bytes, language: Optional[str] = None) -> Dict:
        """Transcriu àudio PCM a text"""
        if not os.path.exists(self.whisper_path):
            return {"error": "Whisper not found"}
        
        # Guardar com a WAV
        wav_data = self._pcm_to_wav(pcm_data)
        wav_path = str(self.tmp_dir / f"stt_{os.getpid()}_{time.time()}.wav")
        
        with open(wav_path, 'wb') as f:
            f.write(wav_data)
        
        try:
            output_base = wav_path.replace('.wav', '')
            cmd = [
                self.whisper_path,
                "-m", self.model_path,
                "-f", wav_path,
                "-t", str(self.threads),
                "-otxt",
                "-of", output_base,
                "--no-timestamps",
            ]
            
            if language:
                cmd.extend(["-l", language])
            
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await proc.communicate()
            
            txt_path = output_base + ".txt"
            if os.path.exists(txt_path):
                text = Path(txt_path).read_text().strip()
                os.unlink(txt_path)
            else:
                text = stdout.decode().strip()
            
            return {"text": text, "language": language}
            
        except Exception as e:
            log.error(f"STT error: {e}")
            return {"error": str(e)}
        finally:
            if os.path.exists(wav_path):
                os.unlink(wav_path)


class TTSProcessor:
    """Processador TTS amb Piper"""
    
    def __init__(self, config: Dict):
        self.piper_path = self._expand(config.get("piperPath", ""))
        self.voices_dir = self._expand(config.get("voicesDir", "~/piper/voices"))
        self.default_voice = self._expand(config.get("voicePath", ""))
        self.length_scale = config.get("lengthScale", 0.7)
        self.tmp_dir = TMP_DIR
        self.tmp_dir.mkdir(parents=True, exist_ok=True)
        
        self.language_voices = {
            "ca": "ca_ES-upc_pau-x_low.onnx",
            "es": "es_ES-sharvard-medium.onnx", 
            "en": "en_US-lessac-medium.onnx",
        }
        
        log.info(f"TTS initialized: {self.piper_path}")
    
    def _expand(self, p: str) -> str:
        return os.path.expanduser(os.path.expandvars(p)) if p else ""
    
    async def synthesize(self, text: str, language: str = "ca") -> Dict:
        """Genera àudio des de text, retorna PCM16 raw"""
        if not os.path.exists(self.piper_path):
            return {"error": "Piper not found"}
        
        # Seleccionar veu
        voice_file = self.language_voices.get(language, self.language_voices["ca"])
        voice_path = os.path.join(self.voices_dir, voice_file)
        
        if not os.path.exists(voice_path):
            voice_path = self.default_voice
        
        wav_path = str(self.tmp_dir / f"tts_{os.getpid()}_{time.time()}.wav")
        
        try:
            cmd = [
                self.piper_path,
                "--model", voice_path,
                "--output_file", wav_path,
                "--length_scale", str(self.length_scale),
            ]
            
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env={**os.environ, "LD_LIBRARY_PATH": str(Path(self.piper_path).parent)}
            )
            stdout, stderr = await proc.communicate(input=text.encode())
            
            if proc.returncode != 0:
                return {"error": f"Piper failed: {stderr.decode()}"}
            
            # Convertir WAV a PCM raw (resamplejar a 48kHz stereo)
            pcm_path = wav_path.replace('.wav', '.raw')
            
            resample_cmd = [
                "ffmpeg", "-y", "-i", wav_path,
                "-ar", str(SAMPLE_RATE),
                "-ac", str(CHANNELS),
                "-f", "s16le",
                pcm_path
            ]
            
            proc = await asyncio.create_subprocess_exec(
                *resample_cmd,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL
            )
            await proc.communicate()
            
            if os.path.exists(pcm_path):
                with open(pcm_path, 'rb') as f:
                    pcm_data = f.read()
                os.unlink(pcm_path)
                return {"pcm_data": pcm_data, "sample_rate": SAMPLE_RATE, "channels": CHANNELS}
            
            return {"error": "Failed to convert to PCM"}
            
        except Exception as e:
            log.error(f"TTS error: {e}")
            return {"error": str(e)}
        finally:
            if os.path.exists(wav_path):
                os.unlink(wav_path)


class VoiceChatSession:
    """Sessió de voice chat individual"""
    
    def __init__(
        self,
        chat_id: int,
        call_py: 'PyTgCalls',
        stt: STTProcessor,
        tts: TTSProcessor,
        on_transcription: Callable,
    ):
        self.chat_id = chat_id
        self.call_py = call_py
        self.stt = stt
        self.tts = tts
        self.on_transcription = on_transcription
        
        self.audio_buffers: Dict[int, AudioBuffer] = {}  # per user_id
        self.is_speaking = False
        self.tts_queue: asyncio.Queue = asyncio.Queue()
        self.running = True
        
        log.info(f"VoiceChat session created for {chat_id}")
    
    def get_or_create_buffer(self, user_id: int) -> AudioBuffer:
        """Obté o crea buffer per un usuari"""
        if user_id not in self.audio_buffers:
            self.audio_buffers[user_id] = AudioBuffer()
        return self.audio_buffers[user_id]
    
    async def process_incoming_frame(self, user_id: int, frame: bytes):
        """Processa un frame d'àudio entrant"""
        buffer = self.get_or_create_buffer(user_id)
        complete_audio = buffer.add_frame(frame)
        
        if complete_audio:
            # Tenim àudio complet, transcriure
            log.info(f"Processing audio from user {user_id} ({len(complete_audio)} bytes)")
            result = await self.stt.transcribe(complete_audio)
            
            if "text" in result and result["text"].strip():
                await self.on_transcription(self.chat_id, user_id, result["text"])
    
    async def speak(self, text: str, language: str = "ca"):
        """Envia text com a veu al voice chat"""
        log.info(f"Speaking in {self.chat_id}: {text[:50]}...")
        
        result = await self.tts.synthesize(text, language)
        
        if "error" in result:
            log.error(f"TTS error: {result['error']}")
            return False
        
        pcm_data = result["pcm_data"]
        
        # Enviar en chunks
        chunk_size = SAMPLE_RATE * 16 // 8 // 100 * CHANNELS  # 10ms chunks
        
        self.is_speaking = True
        try:
            for i in range(0, len(pcm_data), chunk_size):
                if not self.running:
                    break
                chunk = pcm_data[i:i + chunk_size]
                if len(chunk) < chunk_size:
                    chunk += b'\x00' * (chunk_size - len(chunk))
                
                await self.call_py.send_frame(
                    self.chat_id,
                    Device.MICROPHONE,
                    chunk,
                )
                await asyncio.sleep(0.01)
        finally:
            self.is_speaking = False
        
        return True
    
    def stop(self):
        """Atura la sessió"""
        self.running = False
        for buffer in self.audio_buffers.values():
            buffer.clear()


class VoiceChatService:
    """Servei principal de Voice Chat"""
    
    def __init__(self, config: Dict):
        self.config = config
        self.client: Optional[Client] = None
        self.call_py: Optional[PyTgCalls] = None
        
        self.stt = STTProcessor(config.get("stt", {}))
        self.tts = TTSProcessor(config.get("tts", {}))
        
        self.sessions: Dict[int, VoiceChatSession] = {}
        self.event_handlers: List[Callable] = []
        
        # Callback per notificar Clawdbot
        self.clawdbot_callback: Optional[Callable] = None
        
        log.info("VoiceChatService initialized")
    
    async def start(self) -> bool:
        """Inicia el servei"""
        if not PYROGRAM_AVAILABLE or not PYTGCALLS_AVAILABLE:
            log.error("Missing dependencies: pyrogram or pytgcalls")
            return False
        
        session_file = SESSION_PATH.with_suffix('.session')
        if not session_file.exists():
            log.warning(f"Session not found: {session_file}")
            return False
        
        api_id = self.config.get('apiId')
        api_hash = self.config.get('apiHash')
        
        if not api_id or not api_hash:
            log.warning("API credentials not found")
            return False
        
        try:
            self.client = Client(
                name=str(SESSION_PATH),
                api_id=api_id,
                api_hash=api_hash,
            )
            
            self.call_py = PyTgCalls(self.client)
            
            # Registrar handlers
            @self.call_py.on_update(ptg_filters.chat_update(ChatUpdate.Status.INCOMING_CALL))
            async def on_incoming_call(_, update: ChatUpdate):
                await self._handle_incoming_call(update)
            
            @self.call_py.on_update(ptg_filters.stream_frame(Direction.INCOMING, Device.MICROPHONE))
            async def on_audio_frame(_, update: StreamFrames):
                await self._handle_audio_frame(update)
            
            await self.call_py.start()
            log.info("VoiceChatService started")
            return True
            
        except Exception as e:
            log.error(f"Failed to start: {e}")
            return False
    
    async def stop(self):
        """Atura el servei"""
        for session in self.sessions.values():
            session.stop()
        self.sessions.clear()
        
        if self.call_py:
            # Leave all calls
            pass
        
        if self.client:
            await self.client.stop()
    
    async def _handle_incoming_call(self, update: ChatUpdate):
        """Gestiona trucades entrants"""
        chat_id = update.chat_id
        log.info(f"📞 Incoming call from {chat_id}")
        
        await self.emit_event('call.incoming', {'chat_id': chat_id})
        
        # Auto-answer si configurat
        if self.config.get('autoAnswer', True):
            await asyncio.sleep(self.config.get('autoAnswerDelay', 1.0))
            await self.join_call(chat_id)
    
    async def _handle_audio_frame(self, update: StreamFrames):
        """Gestiona frames d'àudio entrants"""
        chat_id = update.chat_id
        
        if chat_id not in self.sessions:
            return
        
        session = self.sessions[chat_id]
        
        for frame_data in update.frames:
            user_id = frame_data.user_id if hasattr(frame_data, 'user_id') else 0
            await session.process_incoming_frame(user_id, frame_data.frame)
    
    async def _on_transcription(self, chat_id: int, user_id: int, text: str):
        """Callback quan es transcriu àudio"""
        log.info(f"📝 Transcription from {user_id} in {chat_id}: {text}")
        
        await self.emit_event('transcription', {
            'chat_id': chat_id,
            'user_id': user_id,
            'text': text,
        })
        
        # Notificar Clawdbot per processar
        if self.clawdbot_callback:
            try:
                response = await self.clawdbot_callback(chat_id, user_id, text)
                if response:
                    session = self.sessions.get(chat_id)
                    if session:
                        await session.speak(response)
            except Exception as e:
                log.error(f"Clawdbot callback error: {e}")
    
    async def join_call(self, chat_id: int, stream_url: Optional[str] = None) -> Dict:
        """Uneix-se a un voice chat o trucada"""
        if not self.call_py:
            return {"error": "Service not started"}
        
        try:
            # Crear sessió
            session = VoiceChatSession(
                chat_id=chat_id,
                call_py=self.call_py,
                stt=self.stt,
                tts=self.tts,
                on_transcription=self._on_transcription,
            )
            self.sessions[chat_id] = session
            
            # Unir-se amb streaming bidireccional
            await self.call_py.play(
                chat_id,
                MediaStream(ExternalMedia.AUDIO, AudioParameters(SAMPLE_RATE, CHANNELS))
                if not stream_url else stream_url,
            )
            
            # Activar recording
            await self.call_py.record(
                chat_id,
                RecordStream(True, AUDIO_QUALITY),
            )
            
            log.info(f"Joined voice chat {chat_id}")
            await self.emit_event('call.joined', {'chat_id': chat_id})
            
            return {"joined": True, "chat_id": chat_id}
            
        except Exception as e:
            log.error(f"Failed to join {chat_id}: {e}")
            return {"error": str(e)}
    
    async def leave_call(self, chat_id: int) -> Dict:
        """Surt d'un voice chat"""
        if chat_id in self.sessions:
            self.sessions[chat_id].stop()
            del self.sessions[chat_id]
        
        if self.call_py:
            try:
                await self.call_py.leave_call(chat_id)
            except Exception:
                pass
        
        await self.emit_event('call.left', {'chat_id': chat_id})
        return {"left": True, "chat_id": chat_id}
    
    async def speak(self, chat_id: int, text: str, language: str = "ca") -> Dict:
        """Parla en un voice chat"""
        session = self.sessions.get(chat_id)
        if not session:
            return {"error": f"Not in voice chat {chat_id}"}
        
        success = await session.speak(text, language)
        return {"spoken": success, "text": text}
    
    async def get_status(self) -> Dict:
        """Retorna l'estat del servei"""
        return {
            "service": SERVICE_NAME,
            "version": VERSION,
            "running": self.call_py is not None,
            "active_sessions": list(self.sessions.keys()),
            "pyrogram": PYROGRAM_AVAILABLE,
            "pytgcalls": PYTGCALLS_AVAILABLE,
        }
    
    def add_event_handler(self, handler: Callable):
        self.event_handlers.append(handler)
    
    async def emit_event(self, event_type: str, params: Dict):
        log.info(f"Event: {event_type} - {params}")
        for handler in self.event_handlers:
            try:
                if asyncio.iscoroutinefunction(handler):
                    await handler(event_type, params)
                else:
                    handler(event_type, params)
            except Exception as e:
                log.error(f"Event handler error: {e}")


# ============================================================================
# JSON-RPC SERVER
# ============================================================================

class JSONRPCServer:
    """Servidor JSON-RPC"""
    
    def __init__(self, service: VoiceChatService):
        self.service = service
        self.clients: List[asyncio.StreamWriter] = []
        
        self.methods = {
            "status": self._handle_status,
            "join": self._handle_join,
            "leave": self._handle_leave,
            "speak": self._handle_speak,
            "health": self._handle_health,
        }
        
        service.add_event_handler(self._on_event)
    
    async def _on_event(self, event_type: str, params: Dict):
        """Broadcast events to clients"""
        notification = json.dumps({
            "jsonrpc": "2.0",
            "method": event_type,
            "params": params
        }).encode()
        await self._broadcast(notification)
    
    async def _broadcast(self, data: bytes):
        for writer in self.clients[:]:
            try:
                writer.write(len(data).to_bytes(4, 'big'))
                writer.write(data)
                await writer.drain()
            except Exception:
                self.clients.remove(writer)
    
    async def handle_request(self, data: bytes) -> bytes:
        try:
            request = json.loads(data.decode())
        except json.JSONDecodeError:
            return self._error_response(None, -32700, "Parse error")
        
        return await self._process_single(request)
    
    async def _process_single(self, request: Dict) -> bytes:
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
    
    async def _handle_status(self, params: Dict) -> Dict:
        return await self.service.get_status()
    
    async def _handle_join(self, params: Dict) -> Dict:
        chat_id = params.get("chat_id")
        if not chat_id:
            raise ValueError("chat_id required")
        return await self.service.join_call(int(chat_id))
    
    async def _handle_leave(self, params: Dict) -> Dict:
        chat_id = params.get("chat_id")
        if not chat_id:
            raise ValueError("chat_id required")
        return await self.service.leave_call(int(chat_id))
    
    async def _handle_speak(self, params: Dict) -> Dict:
        chat_id = params.get("chat_id")
        text = params.get("text")
        language = params.get("language", "ca")
        if not chat_id or not text:
            raise ValueError("chat_id and text required")
        return await self.service.speak(int(chat_id), text, language)
    
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
    server.clients.append(writer)
    
    try:
        while True:
            length_bytes = await reader.read(4)
            if not length_bytes:
                break
            
            length = int.from_bytes(length_bytes, 'big')
            if length > 10 * 1024 * 1024:
                break
            
            data = await reader.read(length)
            if not data:
                break
            
            response = await server.handle_request(data)
            
            writer.write(len(response).to_bytes(4, 'big'))
            writer.write(response)
            await writer.drain()
            
    except asyncio.CancelledError:
        pass
    except Exception as e:
        log.error(f"Client error: {e}")
    finally:
        if writer in server.clients:
            server.clients.remove(writer)
        writer.close()
        await writer.wait_closed()
        log.info(f"Client disconnected: {addr}")


def load_config() -> Dict:
    """Carrega configuració"""
    if CONFIG_PATH.exists():
        return json.loads(CONFIG_PATH.read_text())
    
    clawdbot_config = Path.home() / ".clawdbot" / "clawdbot.json"
    if clawdbot_config.exists():
        config = json.loads(clawdbot_config.read_text())
        userbot_config = config.get("channels", {}).get("telegram-userbot", {})
        return {
            "apiId": userbot_config.get("apiId"),
            "apiHash": userbot_config.get("apiHash"),
            "autoAnswer": userbot_config.get("calls", {}).get("autoAnswer", True),
            "autoAnswerDelay": userbot_config.get("calls", {}).get("autoAnswerDelay", 1000) / 1000,
            "stt": userbot_config.get("stt", {}),
            "tts": userbot_config.get("tts", {}),
        }
    
    return {
        "stt": {
            "whisperPath": "~/whisper.cpp/build/bin/whisper-cli",
            "modelPath": "~/whisper.cpp/models/ggml-small.bin",
            "threads": 4,
        },
        "tts": {
            "piperPath": "~/piper/piper/piper",
            "voicesDir": "~/piper/voices",
            "voicePath": "~/piper/voices/ca_ES-upc_pau-x_low.onnx",
            "lengthScale": 0.7,
        },
    }


async def main():
    """Entry point"""
    log.info(f"🎤 Telegram VoiceChat Service v{VERSION}")
    log.info(f"   Pyrogram: {'✅' if PYROGRAM_AVAILABLE else '❌'}")
    log.info(f"   PyTgCalls: {'✅' if PYTGCALLS_AVAILABLE else '❌'}")
    log.info(f"   NumPy: {'✅' if NUMPY_AVAILABLE else '❌'}")
    
    config = load_config()
    
    service = VoiceChatService(config)
    started = await service.start()
    
    if not started:
        log.error("Failed to start service")
        return
    
    rpc_server = JSONRPCServer(service)
    
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)
    os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)
    
    server = await asyncio.start_unix_server(
        lambda r, w: handle_client(r, w, rpc_server),
        path=SOCKET_PATH
    )
    os.chmod(SOCKET_PATH, 0o600)
    
    log.info(f"🚀 Listening on: {SOCKET_PATH}")
    
    loop = asyncio.get_event_loop()
    
    async def shutdown():
        log.info("👋 Shutting down...")
        await service.stop()
        server.close()
        await server.wait_closed()
        if os.path.exists(SOCKET_PATH):
            os.unlink(SOCKET_PATH)
    
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: asyncio.create_task(shutdown()))
    
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Interrupted")
