#!/usr/bin/env python3
"""
Test script for aiortc P2P calls

This script demonstrates how to use the AiortcP2PCall class
for making real P2P voice calls with full audio streaming.
"""

import asyncio
import logging
import sys
from pathlib import Path

# Add parent to path
sys.path.insert(0, str(Path(__file__).parent))

from aiortc_p2p_calls import AiortcP2PCall

# Configuration
API_ID = 12345678  # Replace with your API ID
API_HASH = "your_api_hash_here"  # Replace with your API hash
PHONE = "+1234567890"  # Replace with your phone
SESSION_NAME = "test_call_session"

TARGET_USER_ID = 123456789  # Replace with user ID to call

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
log = logging.getLogger(__name__)


class MockVoiceService:
    """
    Mock voice service for testing

    In production, this would be the actual VoiceService
    with Whisper STT and Piper TTS
    """

    async def transcribe(self, audio_path: str, **kwargs):
        """Mock transcribe - just returns test text"""
        log.info(f"[MOCK] Transcribing: {audio_path}")
        return {
            'text': 'Hello this is a test',
            'language': 'en'
        }

    async def synthesize(self, text: str, **kwargs):
        """Mock synthesize - returns path to silence"""
        log.info(f"[MOCK] Synthesizing: {text}")
        return {
            'audio_path': '/tmp/silence.wav'
        }


async def main():
    """Test the P2P call system"""
    from pyrogram import Client

    log.info("🚀 Starting P2P call test...")

    # Create Pyrogram client
    client = Client(
        SESSION_NAME,
        api_id=API_ID,
        api_hash=API_HASH,
        phone_number=PHONE
    )

    # Event handler
    async def handle_event(event_type: str, params: dict):
        log.info(f"📢 EVENT: {event_type}")
        log.info(f"   Params: {params}")

        # When speech is detected, respond
        if event_type == "call.speech":
            text = params.get('text', '')
            log.info(f"   User said: {text}")

            # Generate and play response
            response = f"I heard you say: {text}"
            await call_service.speak_text(response)

    try:
        # Start client
        await client.start()
        log.info("✅ Pyrogram client started")

        # Create mock voice service
        voice_service = MockVoiceService()

        # Create call service
        call_service = AiortcP2PCall(
            client=client,
            voice_service=voice_service,
            on_event=handle_event
        )

        log.info("✅ Call service created")

        # Make a call
        log.info(f"📞 Calling user {TARGET_USER_ID}...")
        result = await call_service.request_call(TARGET_USER_ID)

        if 'error' in result:
            log.error(f"❌ Call failed: {result['error']}")
            return

        log.info(f"✅ Call initiated: {result}")

        # Wait for call to end (or timeout after 5 minutes)
        timeout = 300  # 5 minutes
        elapsed = 0

        while call_service.state.state != "ENDED" and elapsed < timeout:
            await asyncio.sleep(1)
            elapsed += 1

            # Print status every 10 seconds
            if elapsed % 10 == 0:
                status = call_service.get_status()
                log.info(f"📊 Status: {status}")

        if call_service.state.state == "ENDED":
            log.info(f"✅ Call ended normally (duration: {call_service.state.duration:.1f}s)")
        else:
            log.warning("⏱️ Test timeout reached, hanging up...")
            await call_service.hangup()

    except KeyboardInterrupt:
        log.info("\n⚠️ Interrupted by user")
        if 'call_service' in locals():
            await call_service.hangup()

    except Exception as e:
        log.error(f"❌ Error: {e}", exc_info=True)

    finally:
        # Cleanup
        await client.stop()
        log.info("👋 Test complete")


if __name__ == "__main__":
    # Check if configuration is set
    if API_ID == 12345678 or API_HASH == "your_api_hash_here":
        print("\n⚠️ ERROR: Please configure API credentials in the script!")
        print("   Edit test-aiortc-call.py and set:")
        print("   - API_ID")
        print("   - API_HASH")
        print("   - PHONE")
        print("   - TARGET_USER_ID")
        print()
        sys.exit(1)

    asyncio.run(main())
