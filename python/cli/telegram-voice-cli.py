#!/usr/bin/env python3
"""
Telegram Voice CLI - Test client for telegram-voice service

Usage:
  telegram-voice-cli status                    # Check service status
  telegram-voice-cli transcribe <audio_file>   # Transcribe audio (auto-detect language)
  telegram-voice-cli transcribe <audio_file> --lang es  # Force language
  telegram-voice-cli synthesize "Hola món"     # Generate speech
  telegram-voice-cli synthesize "Hello" --lang en       # Generate in specific language
  telegram-voice-cli language get <user_id>    # Get user's language
  telegram-voice-cli language set <user_id> ca # Set user's language
"""

import argparse
import json
import socket
import sys
import os
import subprocess
from pathlib import Path

# Socket path
SOCKET_PATH = f"/run/user/{os.getuid()}/tts-stt.sock"

def send_request(method: str, params: dict = None) -> dict:
    """Send JSON-RPC request to the service"""
    params = params or {}
    
    request = {
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
        "id": 1
    }
    
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(120)  # 2 minutes timeout for slow operations
        sock.connect(SOCKET_PATH)
        
        data = json.dumps(request).encode()
        sock.send(len(data).to_bytes(4, 'big'))
        sock.send(data)
        
        length_bytes = sock.recv(4)
        if not length_bytes:
            raise Exception("No response from service")
        
        length = int.from_bytes(length_bytes, 'big')
        response_data = sock.recv(length)
        sock.close()
        
        return json.loads(response_data)
        
    except FileNotFoundError:
        print(f"❌ Service not running (socket not found: {SOCKET_PATH})")
        print("   Start with: systemctl --user start telegram-voice")
        sys.exit(1)
    except ConnectionRefusedError:
        print(f"❌ Connection refused to {SOCKET_PATH}")
        sys.exit(1)
    except socket.timeout:
        print("❌ Request timeout (>120s)")
        sys.exit(1)
    except Exception as e:
        print(f"❌ Error: {e}")
        sys.exit(1)


def cmd_status(args):
    """Check service status"""
    print("🔍 Checking telegram-voice service...")
    
    response = send_request("status")
    
    if "error" in response:
        print(f"❌ Error: {response['error']['message']}")
        sys.exit(1)
    
    result = response.get("result", {})
    
    print(f"\n📊 Telegram Voice Service v{result.get('version', '?')}")
    print(f"   Transport: {result.get('transport', '?')}")
    print(f"   Socket: {result.get('socket', '?')}")
    print()
    print(f"   faster-whisper: {'✅' if result.get('faster_whisper') else '❌'}")
    print(f"   Model small: {'✅ loaded' if result.get('model_small_loaded') else '❌ not loaded'}")
    print(f"   Model medium: {'✅ loaded' if result.get('model_medium_loaded') else '❌ not loaded'}")
    print(f"   Piper TTS: {'✅' if result.get('piper_available') else '❌'}")
    print()
    print(f"   Languages: {', '.join(result.get('supported_languages', []))}")
    print(f"   Active users: {result.get('active_users', 0)}")


def cmd_transcribe(args):
    """Transcribe audio file"""
    audio_path = os.path.abspath(args.file)
    
    if not os.path.exists(audio_path):
        print(f"❌ File not found: {audio_path}")
        sys.exit(1)
    
    params = {"audio_path": audio_path}
    if args.lang:
        params["force_language"] = args.lang
        print(f"🎤 Transcribing {args.file} (forced lang: {args.lang})...")
    else:
        print(f"🎤 Transcribing {args.file} (auto-detect)...")
    
    response = send_request("transcribe", params)
    
    if "error" in response:
        print(f"❌ Error: {response['error']['message']}")
        sys.exit(1)
    
    result = response.get("result", {})
    
    if result.get("error"):
        print(f"❌ Transcription failed: {result['error']}")
        sys.exit(1)
    
    detected = "detected" if result.get("detected") else "forced"
    print(f"\n✅ Transcription complete!")
    print(f"   Language: {result.get('language', '?')} ({detected})")
    print(f"\n📝 Text:")
    print(f"   {result.get('text', '')}")


def cmd_synthesize(args):
    """Synthesize text to speech"""
    text = args.text
    
    params = {"text": text}
    if args.lang:
        params["language"] = args.lang
    
    lang_str = f" (lang: {args.lang})" if args.lang else ""
    print(f"🔊 Synthesizing{lang_str}...")
    print(f"   Text: {text[:50]}{'...' if len(text) > 50 else ''}")
    
    response = send_request("synthesize", params)
    
    if "error" in response:
        print(f"❌ Error: {response['error']['message']}")
        sys.exit(1)
    
    result = response.get("result", {})
    
    if result.get("error"):
        print(f"❌ Synthesis failed: {result['error']}")
        sys.exit(1)
    
    audio_path = result.get("audio_path", "")
    print(f"\n✅ Audio generated!")
    print(f"   File: {audio_path}")
    print(f"   Language: {result.get('language', '?')}")
    
    # Offer to play
    if os.path.exists(audio_path):
        print(f"\n▶️  Play with: aplay {audio_path}")
        if args.play:
            print("   Playing...")
            subprocess.run(["aplay", "-q", audio_path], check=False)


def cmd_language_get(args):
    """Get user's language"""
    response = send_request("language.get", {"user_id": args.user_id})
    
    if "error" in response:
        print(f"❌ Error: {response['error']['message']}")
        sys.exit(1)
    
    result = response.get("result", {})
    print(f"👤 User {result.get('user_id')}")
    print(f"   Language: {result.get('language')} ({result.get('language_name')})")


def cmd_language_set(args):
    """Set user's language"""
    response = send_request("language.set", {
        "user_id": args.user_id,
        "language": args.language
    })
    
    if "error" in response:
        print(f"❌ Error: {response['error']['message']}")
        sys.exit(1)
    
    result = response.get("result", {})
    
    if result.get("error"):
        print(f"❌ Failed: {result['error']}")
        sys.exit(1)
    
    print(f"✅ Language set!")
    print(f"   User: {result.get('user_id')}")
    print(f"   Language: {result.get('language')} ({result.get('language_name')})")


def cmd_health(args):
    """Quick health check"""
    response = send_request("health")
    
    if "error" in response:
        print(f"❌ Error: {response['error']['message']}")
        sys.exit(1)
    
    result = response.get("result", {})
    if result.get("status") == "ok":
        print(f"✅ Service healthy ({result.get('timestamp', '')})")
    else:
        print(f"❌ Service unhealthy")
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        description="Telegram Voice CLI - Test client for telegram-voice service",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s status                         # Check service status
  %(prog)s health                         # Quick health check
  %(prog)s transcribe audio.ogg           # Transcribe with auto-detect
  %(prog)s transcribe audio.ogg --lang es # Transcribe forcing Spanish
  %(prog)s synthesize "Hola món"          # Generate Catalan speech
  %(prog)s synthesize "Hello" --lang en   # Generate English speech
  %(prog)s language get 12345             # Get user's language
  %(prog)s language set 12345 es          # Set user to Spanish
        """
    )
    
    subparsers = parser.add_subparsers(dest="command", help="Command to run")
    
    # status
    parser_status = subparsers.add_parser("status", help="Check service status")
    parser_status.set_defaults(func=cmd_status)
    
    # health
    parser_health = subparsers.add_parser("health", help="Quick health check")
    parser_health.set_defaults(func=cmd_health)
    
    # transcribe
    parser_transcribe = subparsers.add_parser("transcribe", help="Transcribe audio file")
    parser_transcribe.add_argument("file", help="Audio file to transcribe")
    parser_transcribe.add_argument("--lang", "-l", help="Force language (ca/es/en)")
    parser_transcribe.set_defaults(func=cmd_transcribe)
    
    # synthesize
    parser_synth = subparsers.add_parser("synthesize", help="Synthesize text to speech")
    parser_synth.add_argument("text", help="Text to synthesize")
    parser_synth.add_argument("--lang", "-l", help="Language (ca/es/en)")
    parser_synth.add_argument("--play", "-p", action="store_true", help="Play audio after generation")
    parser_synth.set_defaults(func=cmd_synthesize)
    
    # language
    parser_lang = subparsers.add_parser("language", help="Manage user language")
    lang_sub = parser_lang.add_subparsers(dest="lang_command")
    
    parser_lang_get = lang_sub.add_parser("get", help="Get user's language")
    parser_lang_get.add_argument("user_id", help="User ID")
    parser_lang_get.set_defaults(func=cmd_language_get)
    
    parser_lang_set = lang_sub.add_parser("set", help="Set user's language")
    parser_lang_set.add_argument("user_id", help="User ID")
    parser_lang_set.add_argument("language", help="Language code (ca/es/en)")
    parser_lang_set.set_defaults(func=cmd_language_set)
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        sys.exit(1)
    
    if args.command == "language" and not hasattr(args, 'func'):
        parser_lang.print_help()
        sys.exit(1)
    
    args.func(args)


if __name__ == "__main__":
    main()
