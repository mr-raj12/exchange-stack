#!/usr/bin/env bash
#
# smoke-test.sh — boot engine + backend, run the full end-to-end flow,
# then tear everything down. Run from anywhere; it locates the repo itself.
#
# ./smoke-test.sh
#
# Exit code 0 = all hard checks passed, non-zero = something failed.

set -u # error on undefined vars; we handle command failures manually

# ─── locate repo & config ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
ENGINE_DIR="$SCRIPT_DIR/engine"

# port the backend listens on (from backend/.env, default 3000)
PORT="$(grep -E '^PORT=' "$BACKEND_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"' | tr -d "'" )"
PORT="${PORT:-3000}"
BASE="http://localhost:$PORT"

LOG_DIR="$(mktemp -d)"
BACKEND_LOG="$LOG_DIR/backend.log"
ENGINE_LOG="$LOG_DIR/engine.log"

PASS=0
FAIL=0
BACKEND_PID=""
ENGINE_PID=""

# ─── pretty output ───────────────────────────────────────────────────────────
green() { printf '\033[32m%s\033[0m\n' "$1"; }
red() { printf '\033[31m%s\033[0m\n' "$1"; }
info() { printf '\033[36m• %s\033[0m\n' "$1"; }

check() { # check <name> <condition-result(0/1)> [detail]
 if [ "$2" -eq 0 ]; then
 green " ✓ $1"; PASS=$((PASS + 1))
 else
 red " ✗ $1${3:+ — $3}"; FAIL=$((FAIL + 1))
 fi
}

# ─── cleanup: always kill what we started ────────────────────────────────────
cleanup() {
 info "Shutting down..."
 [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null
 [ -n "$ENGINE_PID" ] && kill "$ENGINE_PID" 2>/dev/null
 # reap any stragglers from this run only
 [ -n "$BACKEND_PID" ] && pkill -P "$BACKEND_PID" 2>/dev/null
 [ -n "$ENGINE_PID" ] && pkill -P "$ENGINE_PID" 2>/dev/null
 wait 2>/dev/null
 rm -rf "$LOG_DIR"
}
trap cleanup EXIT INT TERM

# ─── preflight ───────────────────────────────────────────────────────────────
info "Preflight checks"

command -v bun >/dev/null 2>&1 || { red "bun not found on PATH"; exit 1; }
[ -f "$BACKEND_DIR/.env" ] || { red "backend/.env missing"; exit 1; }
[ -f "$ENGINE_DIR/.env" ] || { red "engine/.env missing"; exit 1; }

if lsof -i ":$PORT" >/dev/null 2>&1; then
 red "Port $PORT already in use — stop the other process first"; exit 1
fi

info "Installing dependencies (idempotent)"
( cd "$BACKEND_DIR" && bun install ) >/dev/null 2>&1 || { red "bun install failed (backend)"; exit 1; }
( cd "$ENGINE_DIR" && bun install ) >/dev/null 2>&1 || { red "bun install failed (engine)"; exit 1; }

info "Prisma generate + migrate deploy (non-destructive)"
( cd "$BACKEND_DIR" && bunx prisma generate ) >/dev/null 2>&1 \
 || red " prisma generate failed (continuing — client may already exist)"
( cd "$BACKEND_DIR" && bunx prisma migrate deploy ) >/dev/null 2>&1 \
 || red " migrate deploy failed (continuing — schema may already be applied)"

# ─── start engine ────────────────────────────────────────────────────────────
info "Starting engine"
( cd "$ENGINE_DIR" && exec bun run src/index.ts ) >"$ENGINE_LOG" 2>&1 &
ENGINE_PID=$!

for i in $(seq 1 30); do
 grep -q "Engine listening on Redis queue" "$ENGINE_LOG" 2>/dev/null && break
 kill -0 "$ENGINE_PID" 2>/dev/null || { red "Engine died on startup:"; cat "$ENGINE_LOG"; exit 1; }
 sleep 1
done
if ! grep -q "Engine listening on Redis queue" "$ENGINE_LOG" 2>/dev/null; then
 red "Engine did not become ready in 30s:"; cat "$ENGINE_LOG"; exit 1
fi
green " engine ready"

# ─── start backend ───────────────────────────────────────────────────────────
info "Starting backend"
( cd "$BACKEND_DIR" && exec bun run src/index.ts ) >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

for i in $(seq 1 30); do
 if curl -fsS "$BASE/health" 2>/dev/null | grep -q '"ok":true'; then break; fi
 kill -0 "$BACKEND_PID" 2>/dev/null || { red "Backend died on startup:"; cat "$BACKEND_LOG"; exit 1; }
 sleep 1
done
if ! curl -fsS "$BASE/health" 2>/dev/null | grep -q '"ok":true'; then
 red "Backend did not become ready in 30s:"; cat "$BACKEND_LOG"; exit 1
fi
green " backend ready (health OK = backend + Redis up)"

# ─── tests ───────────────────────────────────────────────────────────────────
echo
info "Running end-to-end checks"

USER="smoke_$(date +%s)_$RANDOM"
PASSWORD="hunter2"
BODY="$LOG_DIR/body.json"

# 1. health
code=$(curl -s -o "$BODY" -w '%{http_code}' "$BASE/health")
[ "$code" = "200" ] && grep -q '"ok":true' "$BODY"; check "GET /health → 200 {ok:true}" $?

# 2. signup → 201 + token
code=$(curl -s -o "$BODY" -w '%{http_code}' -X POST "$BASE/signup" \
 -H 'Content-Type: application/json' \
 -d "{\"username\":\"$USER\",\"password\":\"$PASSWORD\"}")
[ "$code" = "201" ] && grep -q '"token"' "$BODY"; check "POST /signup → 201 + token" $? "got HTTP $code"

TOKEN=$(grep -oE '"token":"[^"]+"' "$BODY" | head -1 | cut -d'"' -f4)
[ -n "$TOKEN" ]; check "JWT extracted from signup response" $?

# 3. duplicate signup → 409
code=$(curl -s -o "$BODY" -w '%{http_code}' -X POST "$BASE/signup" \
 -H 'Content-Type: application/json' \
 -d "{\"username\":\"$USER\",\"password\":\"$PASSWORD\"}")
[ "$code" = "409" ]; check "POST /signup (duplicate) → 409" $? "got HTTP $code"

# 4. validation failure → 400
code=$(curl -s -o "$BODY" -w '%{http_code}' -X POST "$BASE/signup" \
 -H 'Content-Type: application/json' -d '{"username":""}')
[ "$code" = "400" ]; check "POST /signup (bad body) → 400" $? "got HTTP $code"

# 5. protected route without token → 401
code=$(curl -s -o "$BODY" -w '%{http_code}' -X POST "$BASE/order" \
 -H 'Content-Type: application/json' \
 -d '{"type":"limit","side":"buy","symbol":"BTC","price":100,"qty":1}')
[ "$code" = "401" ]; check "POST /order (no token) → 401" $? "got HTTP $code"

# 6. THE BIG ONE: create order — full 7-hop round trip through the engine
code=$(curl -s -o "$BODY" -w '%{http_code}' -X POST "$BASE/order" \
 -H 'Content-Type: application/json' \
 -H "Authorization: Bearer $TOKEN" \
 -d '{"type":"limit","side":"buy","symbol":"BTC","price":100,"qty":1}')
[ "$code" = "200" ] && grep -q '"status":"filled"' "$BODY"
check "POST /order → 200, engine stub round-trip" $? "HTTP $code, body=$(cat "$BODY")"

# 7. depth — proves round-trip even for an unimplemented type
# (engine throws → backend relays the TODO error: plumbing verified)
code=$(curl -s -o "$BODY" -w '%{http_code}' "$BASE/depth/BTC" \
 -H "Authorization: Bearer $TOKEN")
[ "$code" = "400" ] && grep -q 'TODO(student)' "$BODY"
check "GET /depth/BTC → engine reached (400 TODO error)" $? "HTTP $code, body=$(cat "$BODY")"

# 8. balance — same: confirms the queue path for another type
code=$(curl -s -o "$BODY" -w '%{http_code}' "$BASE/balance" \
 -H "Authorization: Bearer $TOKEN")
[ "$code" = "400" ] && grep -q 'TODO(student)' "$BODY"
check "GET /balance → engine reached (400 TODO error)" $? "HTTP $code, body=$(cat "$BODY")"

# 9. signin is an unimplemented stub → request never responds.
# Probe with a short timeout; a timeout here is the EXPECTED current state.
curl -s --max-time 5 -o /dev/null -X POST "$BASE/signin" \
 -H 'Content-Type: application/json' \
 -d "{\"username\":\"$USER\",\"password\":\"$PASSWORD\"}" 2>/dev/null
if [ $? -eq 28 ]; then
 green " ✓ POST /signin → hangs (TODO not implemented — expected)"; PASS=$((PASS + 1))
else
 red " ✗ POST /signin → unexpectedly responded (did someone implement it?)"; FAIL=$((FAIL + 1))
fi

# ─── summary ─────────────────────────────────────────────────────────────────
echo
if [ "$FAIL" -eq 0 ]; then
 green "ALL $PASS CHECKS PASSED — full pipeline works end to end."
 exit 0
else
 red "$FAIL FAILED, $PASS passed."
 echo "── backend log (tail) ──"; tail -n 20 "$BACKEND_LOG"
 echo "── engine log (tail) ──"; tail -n 20 "$ENGINE_LOG"
 exit 1
fi

