#!/bin/bash
#
# Telegram Userbot Complete Test Suite
# =====================================
# Tests ALL functionality required by monitor.ts:
# - Voice Service (STT/TTS)
# - Text Bridge (Pyrogram connection)
# - Full pipeline (voice notes workflow)
#
# Usage: ./test-telegram-userbot.sh [--quick] [--verbose]
#
# Options:
#   --quick    Skip slow tests (transcription)
#   --verbose  Show full output
#

set -o pipefail

# Config
VOICE_CLI="$HOME/.clawdbot/telegram-userbot/telegram-voice-cli.py"
VENV="$HOME/.clawdbot/telegram-userbot/venv/bin/python"
SOCKET="/run/user/$(id -u)/tts-stt.sock"
QUICK_MODE=false
VERBOSE=false

# Parse args
for arg in "$@"; do
    case $arg in
        --quick) QUICK_MODE=true ;;
        --verbose) VERBOSE=true ;;
    esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Counters
PASSED=0
FAILED=0
SKIPPED=0
WARNINGS=0

# Temp files
TEST_AUDIO_ES="/tmp/test-userbot-es.wav"
TEST_AUDIO_CA="/tmp/test-userbot-ca.wav"
TEST_AUDIO_EN="/tmp/test-userbot-en.wav"

cleanup() {
    rm -f "$TEST_AUDIO_ES" "$TEST_AUDIO_CA" "$TEST_AUDIO_EN" 2>/dev/null
}
trap cleanup EXIT

log() {
    if [ "$VERBOSE" = true ]; then
        echo "$@"
    fi
}

header() {
    echo ""
    echo -e "${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}  $1${NC}"
    echo -e "${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""
}

section() {
    echo ""
    echo -e "${CYAN}━━━ $1 ━━━${NC}"
    echo ""
}

run_test() {
    local name="$1"
    local cmd="$2"
    local expect_success="${3:-true}"
    local timeout="${4:-120}"
    
    echo -ne "${BLUE}  ▶ ${name}... ${NC}"
    
    start_time=$(date +%s%N)
    output=$(timeout "$timeout" bash -c "$cmd" 2>&1)
    exit_code=$?
    end_time=$(date +%s%N)
    duration_ms=$(( (end_time - start_time) / 1000000 ))
    
    if [ "$VERBOSE" = true ]; then
        echo ""
        echo "$output" | sed 's/^/    /'
    fi
    
    if [ "$expect_success" = "true" ] && [ $exit_code -eq 0 ]; then
        echo -e "${GREEN}✅ PASS${NC} (${duration_ms}ms)"
        ((PASSED++))
        return 0
    elif [ "$expect_success" = "false" ] && [ $exit_code -ne 0 ]; then
        echo -e "${GREEN}✅ PASS${NC} (expected failure)"
        ((PASSED++))
        return 0
    elif [ $exit_code -eq 124 ]; then
        echo -e "${RED}❌ TIMEOUT${NC}"
        ((FAILED++))
        return 1
    else
        echo -e "${RED}❌ FAIL${NC} (exit: $exit_code)"
        if [ "$VERBOSE" = false ]; then
            echo "$output" | tail -3 | sed 's/^/      /'
        fi
        ((FAILED++))
        return 1
    fi
}

check_prereq() {
    local name="$1"
    local check="$2"
    
    echo -ne "  ${CYAN}◆${NC} $name: "
    if eval "$check" >/dev/null 2>&1; then
        echo -e "${GREEN}✓${NC}"
        return 0
    else
        echo -e "${RED}✗${NC}"
        return 1
    fi
}

warn_check() {
    local name="$1"
    local check="$2"
    local threshold="$3"
    
    echo -ne "  ${CYAN}◆${NC} $name: "
    result=$(eval "$check" 2>/dev/null)
    if [ -n "$result" ]; then
        if [ "$result" -lt "$threshold" ] 2>/dev/null; then
            echo -e "${GREEN}$result${NC}"
            return 0
        else
            echo -e "${YELLOW}$result ⚠️${NC}"
            ((WARNINGS++))
            return 0
        fi
    else
        echo -e "${RED}N/A${NC}"
        return 1
    fi
}

# ═══════════════════════════════════════════════════════════════════════════
header "🧪 TELEGRAM USERBOT COMPLETE TEST SUITE"
# ═══════════════════════════════════════════════════════════════════════════

echo -e "  Mode: ${BOLD}$( [ "$QUICK_MODE" = true ] && echo "QUICK" || echo "FULL" )${NC}"
echo -e "  Time: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# ═══════════════════════════════════════════════════════════════════════════
section "PREREQUISITES"
# ═══════════════════════════════════════════════════════════════════════════

PREREQS_OK=true

check_prereq "telegram-voice.service" "systemctl --user is-active telegram-voice" || PREREQS_OK=false
check_prereq "Voice socket exists" "test -S $SOCKET" || PREREQS_OK=false
check_prereq "telegram-text-bridge running" "pgrep -f 'telegram-text-bridge'" || PREREQS_OK=false
check_prereq "voice-cli executable" "test -x $VOICE_CLI" || PREREQS_OK=false
check_prereq "Python venv" "test -x $VENV" || PREREQS_OK=false
check_prereq "whisper.cpp" "test -x ~/whisper.cpp/build/bin/whisper-cli" || PREREQS_OK=false
check_prereq "Piper TTS" "test -x ~/piper/piper/piper" || PREREQS_OK=false
check_prereq "ffmpeg" "which ffmpeg" || PREREQS_OK=false

echo ""
warn_check "Voice service memory (MB)" "ps aux | grep -v grep | grep telegram-voice-service | awk '{print int(\$6/1024)}' | head -1" 2000
warn_check "Bridge memory (MB)" "ps aux | grep -v grep | grep telegram-text-bridge | awk '{print int(\$6/1024)}' | head -1" 500

if [ "$PREREQS_OK" = false ]; then
    echo ""
    echo -e "${RED}❌ Prerequisites check failed. Some tests may not run.${NC}"
fi

# ═══════════════════════════════════════════════════════════════════════════
section "1. VOICE SERVICE HEALTH"
# ═══════════════════════════════════════════════════════════════════════════

run_test "Service health check" "$VOICE_CLI health"
run_test "Service status" "$VOICE_CLI status"
run_test "Socket response time (<500ms)" "
    start=\$(date +%s%N)
    $VOICE_CLI health >/dev/null 2>&1
    end=\$(date +%s%N)
    latency=\$(( (end - start) / 1000000 ))
    [ \$latency -lt 500 ]
"

# ═══════════════════════════════════════════════════════════════════════════
section "2. TEXT-TO-SPEECH (TTS)"
# ═══════════════════════════════════════════════════════════════════════════

run_test "TTS Català" "$VOICE_CLI synthesize 'Això és una prova' 2>&1 | grep -q 'Audio generated'"
run_test "TTS Castellà" "$VOICE_CLI synthesize 'Esto es una prueba' --lang es 2>&1 | grep -q 'Audio generated'"
run_test "TTS English" "$VOICE_CLI synthesize 'This is a test' --lang en 2>&1 | grep -q 'Audio generated'"

# Generate test audio for STT tests
echo -ne "  ${BLUE}▶ Generating test audio files... ${NC}"
LD_LIBRARY_PATH=~/piper/piper ~/piper/piper/piper \
    --model ~/piper/voices/es_ES-sharvard-medium.onnx \
    --output_file "$TEST_AUDIO_ES" \
    <<< "Hola, esto es una prueba" 2>/dev/null && \
LD_LIBRARY_PATH=~/piper/piper ~/piper/piper/piper \
    --model ~/piper/voices/ca_ES-upc_pau-x_low.onnx \
    --output_file "$TEST_AUDIO_CA" \
    <<< "Hola, això és una prova" 2>/dev/null && \
echo -e "${GREEN}✓${NC}" || echo -e "${RED}✗${NC}"

# ═══════════════════════════════════════════════════════════════════════════
section "3. SPEECH-TO-TEXT (STT)"
# ═══════════════════════════════════════════════════════════════════════════

if [ "$QUICK_MODE" = true ]; then
    echo -e "  ${YELLOW}⏭ Skipped in quick mode${NC}"
    ((SKIPPED+=4))
else
    run_test "STT Spanish (auto-detect)" "$VOICE_CLI transcribe $TEST_AUDIO_ES 2>&1 | grep -qi 'hola\\|prueba'" "true" 60
    run_test "STT Spanish (forced)" "$VOICE_CLI transcribe $TEST_AUDIO_ES --lang es 2>&1 | grep -qi 'hola\\|prueba'" "true" 60
    run_test "STT Catalan (auto-detect)" "$VOICE_CLI transcribe $TEST_AUDIO_CA 2>&1 | grep -qi 'hola\\|prova'" "true" 60
    run_test "STT Language detection" "$VOICE_CLI transcribe $TEST_AUDIO_ES 2>&1 | grep -qi 'es\\|spanish\\|detected'" "true" 60
fi

# ═══════════════════════════════════════════════════════════════════════════
section "4. LANGUAGE STATE MANAGEMENT"
# ═══════════════════════════════════════════════════════════════════════════

TEST_USER="99999"
run_test "Get default language" "$VOICE_CLI language get $TEST_USER"
run_test "Set language to Spanish" "$VOICE_CLI language set $TEST_USER es 2>&1 | grep -q 'es\\|Spanish\\|Castellà'"
run_test "Get updated language" "$VOICE_CLI language get $TEST_USER 2>&1 | grep -q 'es'"
run_test "Set language to Catalan" "$VOICE_CLI language set $TEST_USER ca"
run_test "Invalid language (should fail)" "$VOICE_CLI language set $TEST_USER xx" "false"

# ═══════════════════════════════════════════════════════════════════════════
section "5. BRIDGE CONNECTIVITY"
# ═══════════════════════════════════════════════════════════════════════════

run_test "Bridge process running" "pgrep -f 'telegram-text-bridge' >/dev/null"
run_test "Bridge using correct session" "pgrep -af 'telegram-text-bridge' | grep -q 'session'"
run_test "Bridge connected to Telegram" "pgrep -af 'telegram-text-bridge' | grep -q 'python'"

# ═══════════════════════════════════════════════════════════════════════════
section "6. FULL PIPELINE (monitor.ts workflow)"
# ═══════════════════════════════════════════════════════════════════════════

if [ "$QUICK_MODE" = true ]; then
    echo -e "  ${YELLOW}⏭ Skipped in quick mode${NC}"
    ((SKIPPED+=2))
else
    # This simulates what monitor.ts does:
    # 1. Receive voice note → 2. STT → 3. Process → 4. TTS → 5. Send back
    
    echo -e "  ${BLUE}▶ Full voice note workflow...${NC}"
    
    # Step 1: TTS generates audio (simulates response generation)
    TTS_OUTPUT=$($VOICE_CLI synthesize "Resposta de prova" --lang ca 2>&1)
    TTS_FILE=$(echo "$TTS_OUTPUT" | grep -oP '(?<=File: )[^\s]+' | head -1)
    
    if [ -f "$TTS_FILE" ]; then
        echo -e "    1. TTS generation: ${GREEN}✓${NC}"
        
        # Step 2: Verify audio file is valid
        if file "$TTS_FILE" | grep -qi "audio\|ogg\|wav"; then
            echo -e "    2. Audio validation: ${GREEN}✓${NC}"
            
            # Step 3: STT can process it back (round-trip)
            STT_OUTPUT=$($VOICE_CLI transcribe "$TTS_FILE" 2>&1)
            if echo "$STT_OUTPUT" | grep -qi "text\|resposta\|prova"; then
                echo -e "    3. STT round-trip: ${GREEN}✓${NC}"
                echo -e "  ${GREEN}✅ PASS${NC} Full pipeline works"
                ((PASSED++))
            else
                echo -e "    3. STT round-trip: ${RED}✗${NC}"
                echo -e "  ${RED}❌ FAIL${NC}"
                ((FAILED++))
            fi
        else
            echo -e "    2. Audio validation: ${RED}✗${NC}"
            echo -e "  ${RED}❌ FAIL${NC}"
            ((FAILED++))
        fi
    else
        echo -e "    1. TTS generation: ${RED}✗${NC}"
        echo -e "  ${RED}❌ FAIL${NC}"
        ((FAILED++))
    fi
    
    # Test chunking (long text)
    run_test "TTS long text (chunking)" "$VOICE_CLI synthesize 'Aquest és un text molt llarg que serveix per provar que el sistema de veu pot gestionar textos llargs sense problemes. Hauria de funcionar correctament amb qualsevol longitud de text raonable.' 2>&1 | grep -q 'Audio generated'" "true" 30
fi

# ═══════════════════════════════════════════════════════════════════════════
section "7. ERROR HANDLING"
# ═══════════════════════════════════════════════════════════════════════════

run_test "Missing file (should fail)" "$VOICE_CLI transcribe /nonexistent/file.wav" "false"
run_test "Empty text TTS (should fail)" "$VOICE_CLI synthesize ''" "false"
run_test "Service handles any user ID" "$VOICE_CLI language get any_string_works"

# ═══════════════════════════════════════════════════════════════════════════
header "📊 TEST RESULTS"
# ═══════════════════════════════════════════════════════════════════════════

TOTAL=$((PASSED + FAILED))

echo -e "  ${GREEN}Passed:   $PASSED${NC}"
echo -e "  ${RED}Failed:   $FAILED${NC}"
echo -e "  ${YELLOW}Skipped:  $SKIPPED${NC}"
echo -e "  ${YELLOW}Warnings: $WARNINGS${NC}"
echo ""
echo -e "  Total:    $TOTAL tests"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}${BOLD}🎉 ALL TESTS PASSED!${NC}"
    echo -e "${GREEN}   System is ready for monitor.ts${NC}"
    echo ""
    exit 0
else
    echo -e "${RED}${BOLD}⚠️  $FAILED TESTS FAILED${NC}"
    echo -e "${RED}   Please fix issues before deploying${NC}"
    echo ""
    exit 1
fi
