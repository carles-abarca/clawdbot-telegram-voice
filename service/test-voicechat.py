#!/usr/bin/env python3
"""
Test client per al VoiceChat Service
"""

import asyncio
import json
import socket
import os
import sys

SOCKET_PATH = f"/run/user/{os.getuid()}/telegram-voicechat.sock"


def send_request(method: str, params: dict = None) -> dict:
    """Envia una request JSON-RPC"""
    request = {
        "jsonrpc": "2.0",
        "method": method,
        "params": params or {},
        "id": 1
    }
    
    data = json.dumps(request).encode()
    
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(SOCKET_PATH)
        sock.sendall(len(data).to_bytes(4, 'big'))
        sock.sendall(data)
        
        length_bytes = sock.recv(4)
        if not length_bytes:
            return {"error": "No response"}
        
        length = int.from_bytes(length_bytes, 'big')
        response_data = sock.recv(length)
        
        return json.loads(response_data.decode())
    finally:
        sock.close()


def main():
    if len(sys.argv) < 2:
        print("Usage: test-voicechat.py <command> [args]")
        print()
        print("Commands:")
        print("  status              - Get service status")
        print("  join <chat_id>      - Join a voice chat")
        print("  leave <chat_id>     - Leave a voice chat")
        print("  speak <chat_id> <text> [lang] - Speak text in voice chat")
        print("  health              - Health check")
        return
    
    cmd = sys.argv[1]
    
    if cmd == "status":
        result = send_request("status")
    elif cmd == "health":
        result = send_request("health")
    elif cmd == "join":
        if len(sys.argv) < 3:
            print("Usage: join <chat_id>")
            return
        result = send_request("join", {"chat_id": int(sys.argv[2])})
    elif cmd == "leave":
        if len(sys.argv) < 3:
            print("Usage: leave <chat_id>")
            return
        result = send_request("leave", {"chat_id": int(sys.argv[2])})
    elif cmd == "speak":
        if len(sys.argv) < 4:
            print("Usage: speak <chat_id> <text> [lang]")
            return
        lang = sys.argv[4] if len(sys.argv) > 4 else "ca"
        result = send_request("speak", {
            "chat_id": int(sys.argv[2]),
            "text": sys.argv[3],
            "language": lang
        })
    else:
        print(f"Unknown command: {cmd}")
        return
    
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
