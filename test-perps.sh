#!/usr/bin/env bash
# =============================================================
# CEX-V2  Perps End-to-End Test Suite
# Usage:   bash test-perps.sh [BASE_URL]
# Env:     VERBOSE=1   — print every request URL + response body
#          ENGINE_TIMEOUT_MS — set in backend .env (default 30000)
# Results: perps-test-results.json
# Deps:    curl, jq
#
# Purpose: smoke + integration test for the perpetual futures v1
# layer.  Covers: auth guards, Zod validation, core match
# lifecycle, position reads, leverage, cancel, market orders,
# queue isolation, and balance accounting.
#
# Deposit is done via POST /spot/deposit because perps uses the
# shared balance store and has no dedicated deposit route.
# =============================================================
set -uo pipefail

BASE_URL="${1:-${BASE_URL:-http://localhost:3000}}"
RESULT_FILE="${RESULT_FILE:-perps-test-results.json}"
RUN_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")
SUFFIX=$(date +%s 2>/dev/null || echo "$$")
SUITE_START_MS=$(date +%s%3N 2>/dev/null || echo 0)

PERPS_MARKET="BTC_USD"

# ── colours ──────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ts() { date +%T.%3N 2>/dev/null || date +%T; }
LAST_SECTION_MS=$SUITE_START_MS

# ── counters + result accumulator ────────────────────────────
PASS=0; FAIL=0; TOTAL=0
TMP=$(mktemp /tmp/perps_results.XXXXXX)
trap 'rm -f "$TMP"' EXIT

# ── shared state ─────────────────────────────────────────────
TOKEN_A=""   # long buyer
TOKEN_B=""   # short seller
TOKEN_C=""   # fresh / leverage test user
SELL_ORDER_ID=""
BUY_ORDER_ID=""

# =============================================================
# run_test NAME METHOD PATH EXPECTED_STATUS [BODY] [TOKEN] [CUSTOM_AUTH]
# =============================================================
run_test() {
    local name="$1" method="$2" path="$3" expected="$4"
    local body="${5:-}" token="${6:-}" custom_auth="${7:-}"
    TOTAL=$((TOTAL + 1))

    local args=(-s -w "\n__CEX_STATUS__%{http_code}" -X "$method" \
                "$BASE_URL$path" -H "Content-Type: application/json")
    if [ -n "$custom_auth" ]; then
        args+=(-H "Authorization: $custom_auth")
    elif [ -n "$token" ]; then
        args+=(-H "Authorization: Bearer $token")
    fi
    [ -n "$body" ] && args+=(-d "$body")

    local t_start; t_start=$(date +%s%3N 2>/dev/null || echo 0)
    local raw; raw=$(curl "${args[@]}" 2>/dev/null)
    local duration_ms=$(( $(date +%s%3N 2>/dev/null || echo 0) - t_start ))
    local actual; actual=$(printf '%s' "$raw" | grep -o '__CEX_STATUS__[0-9]*' | sed 's/__CEX_STATUS__//')
    local resp; resp=$(printf '%s' "$raw" | sed 's/__CEX_STATUS__[0-9]*$//' | sed '$ { /^$/d }')
    [ -z "$actual" ] && actual="000"

    local passed=false
    if [ "$actual" = "$expected" ]; then
        passed=true; PASS=$((PASS + 1))
        printf "  ${GREEN}PASS${NC}  [%s] %-60s HTTP %s  (%d ms)\n" "$(ts)" "$name" "$actual" "$duration_ms"
    else
        FAIL=$((FAIL + 1))
        printf "  ${RED}FAIL${NC}  [%s] %-60s expected=%s  got=%s  (%d ms)\n" "$(ts)" "$name" "$expected" "$actual" "$duration_ms"
        if [ "$resp" != "" ]; then
            printf "        ${RED}body: %s${NC}\n" "$(printf '%s' "$resp" | head -c 200)"
        fi
    fi

    local safe_body; safe_body=$(printf '%s' "$resp" | jq -c . 2>/dev/null || printf '"%s"' "$(printf '%s' "$resp" | tr '"\\' "' " | head -c 200)")
    printf '%s\n' "$(jq -n \
        --arg n  "$name"  --arg m  "$method" --arg p  "$path" \
        --arg e  "$expected" --arg a "$actual" \
        --argjson passed "$passed" --argjson body "$safe_body" \
        --argjson duration_ms "$duration_ms" \
        '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,duration_ms:$duration_ms,response:$body}'
    )" >> "$TMP"
}

_curl_json() {
    [ "${VERBOSE:-0}" = "1" ] && printf "  \033[33m[req %s] %s %s%s\033[0m\n" "$(ts)" "$1" "$BASE_URL" "$2" >&2
    local _resp; _resp=$(curl -s -X "$1" "$BASE_URL$2" -H "Content-Type: application/json" "${@:3}" 2>/dev/null)
    [ "${VERBOSE:-0}" = "1" ] && printf "  \033[33m[res %s] %s\033[0m\n" "$(ts)" "$(printf '%s' "$_resp" | head -c 300)" >&2
    printf '%s' "$_resp"
}

assert_body() {
    local name="$1" expr="$2" expected="$3" resp="$4"
    TOTAL=$((TOTAL + 1))
    local t_start; t_start=$(date +%s%3N 2>/dev/null || echo 0)
    local actual; actual=$(printf '%s' "$resp" | jq -r "$expr" 2>/dev/null || echo "__jq_err__")
    local duration_ms=$(( $(date +%s%3N 2>/dev/null || echo 0) - t_start ))
    local passed=false
    if [ "$actual" = "$expected" ]; then
        passed=true; PASS=$((PASS + 1))
        printf "  ${GREEN}PASS${NC}  [%s] %-60s %s = \"%s\"\n" "$(ts)" "$name" "$expr" "$actual"
    else
        FAIL=$((FAIL + 1))
        printf "  ${RED}FAIL${NC}  [%s] %-60s %s  expected=\"%s\"  got=\"%s\"\n" "$(ts)" "$name" "$expr" "$expected" "$actual"
    fi
    printf '%s\n' "$(jq -n \
        --arg n "$name" --arg e "$expected" --arg a "$actual" --argjson passed "$passed" \
        --argjson duration_ms "$duration_ms" \
        '{name:$n,method:"ASSERT",path:"(body check)",expected_status:0,actual_status:0,passed:$passed,duration_ms:$duration_ms,response:{expected:$e,actual:$a}}'
    )" >> "$TMP"
}

# assert that a jq boolean expr is true
assert_true() {
    local name="$1" expr="$2" resp="$3"
    local result; result=$(printf '%s' "$resp" | jq -r "if ($expr) then \"true\" else \"false\" end" 2>/dev/null || echo "false")
    assert_body "$name" "if ($expr) then \"true\" else \"false\" end" "true" "$resp"
}

section() {
    local now_ms; now_ms=$(date +%s%3N 2>/dev/null || echo 0)
    local elapsed=$(( now_ms - LAST_SECTION_MS ))
    [ "$LAST_SECTION_MS" != "$SUITE_START_MS" ] && [ "$elapsed" -gt 0 ] && \
        printf "  ${YELLOW}└─ section took %d ms${NC}\n" "$elapsed"
    LAST_SECTION_MS=$now_ms
    printf "\n${CYAN}── %s  [%s]${NC}\n" "$1" "$(ts)"
}

# =============================================================
printf "\n${YELLOW}CEX-V2 PERPS Test Suite${NC}\n"
printf "Target  : %s\n" "$BASE_URL"
printf "Results : %s\n" "$RESULT_FILE"
printf "Run at  : %s\n" "$RUN_AT"
printf "Market  : %s\n" "$PERPS_MARKET"
printf "Verbose : %s\n" "${VERBOSE:-0}"
printf "%.70s\n" "══════════════════════════════════════════════════════════════════════"

# ─────────────────────────────────────────────────────────────
section "1 · HEALTH"
# ─────────────────────────────────────────────────────────────
run_test "GET /health → 200 {ok:true}" GET /health 200

# ─────────────────────────────────────────────────────────────
section "2 · SETUP – signup, signin, fund via /spot/deposit"
# ─────────────────────────────────────────────────────────────
USER_A="perps_long_${SUFFIX}"
USER_B="perps_short_${SUFFIX}"
USER_C="perps_lev_${SUFFIX}"
USER_FRESH="perps_fresh_${SUFFIX}"

run_test "POST /signup – user A (long buyer)"   POST /signup 201 \
    "{\"username\":\"$USER_A\",\"password\":\"hunter2hunter\"}"
run_test "POST /signup – user B (short seller)" POST /signup 201 \
    "{\"username\":\"$USER_B\",\"password\":\"hunter2hunter\"}"
run_test "POST /signup – user C (leverage test)" POST /signup 201 \
    "{\"username\":\"$USER_C\",\"password\":\"hunter2hunter\"}"
run_test "POST /signup – fresh user (no position)" POST /signup 201 \
    "{\"username\":\"$USER_FRESH\",\"password\":\"hunter2hunter\"}"

run_test "POST /signin – user A"                POST /signin 200 \
    "{\"username\":\"$USER_A\",\"password\":\"hunter2hunter\"}"
run_test "POST /signin – user B"                POST /signin 200 \
    "{\"username\":\"$USER_B\",\"password\":\"hunter2hunter\"}"

# capture tokens
TOKEN_A=$(_curl_json POST /signin \
    -d "{\"username\":\"$USER_A\",\"password\":\"hunter2hunter\"}" | jq -r '.token // empty')
TOKEN_B=$(_curl_json POST /signin \
    -d "{\"username\":\"$USER_B\",\"password\":\"hunter2hunter\"}" | jq -r '.token // empty')
TOKEN_C=$(_curl_json POST /signin \
    -d "{\"username\":\"$USER_C\",\"password\":\"hunter2hunter\"}" | jq -r '.token // empty')
TOKEN_FRESH=$(_curl_json POST /signin \
    -d "{\"username\":\"$USER_FRESH\",\"password\":\"hunter2hunter\"}" | jq -r '.token // empty')

if [ -z "$TOKEN_A" ] || [ -z "$TOKEN_B" ]; then
    printf "\n  ${RED}FATAL: could not obtain auth tokens. Is the backend running?${NC}\n\n"
fi

# Deposit USD via the SPOT deposit route (shared balance store).
# Perps collateral comes from the same balance — no separate perps deposit.
printf "  ${YELLOW}NOTE: depositing via /spot/deposit (shared balance — perps uses same store)${NC}\n"

run_test "POST /spot/deposit – fund user A \$200k USD"  POST /spot/deposit 200 \
    '{"asset":"USD","amount":200000}' "$TOKEN_A"
run_test "POST /spot/deposit – fund user B \$200k USD"  POST /spot/deposit 200 \
    '{"asset":"USD","amount":200000}' "$TOKEN_B"
run_test "POST /spot/deposit – fund user C \$200k USD"  POST /spot/deposit 200 \
    '{"asset":"USD","amount":200000}' "$TOKEN_C"

# ─────────────────────────────────────────────────────────────
section "3 · PERPS BALANCE – auth guards + sanity"
# ─────────────────────────────────────────────────────────────
run_test "GET /perps/balance – no Authorization → 401"  GET /perps/balance 401
run_test "GET /perps/balance – wrong scheme → 401"      GET /perps/balance 401 \
    "" "" "NotBearer $TOKEN_A"
run_test "GET /perps/balance – tampered token → 401"    GET /perps/balance 401 \
    "" "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJmYWtlIiwiaWF0IjoxfQ.badinvalidsig"
run_test "GET /perps/balance – user A valid → 200"      GET /perps/balance 200 \
    "" "$TOKEN_A"
run_test "GET /perps/balance – user B valid → 200"      GET /perps/balance 200 \
    "" "$TOKEN_B"
run_test "GET /perps/balance – fresh user (zero bal) → 200" GET /perps/balance 200 \
    "" "$TOKEN_FRESH"

# Verify the balance returned includes USD deposited via spot
BAL_A=$(_curl_json GET /perps/balance -H "Authorization: Bearer $TOKEN_A")
assert_body "Perps balance: user A USD = 200000 (spot deposit funded perps store)" \
    '.balance.USD' "200000" "$BAL_A"

# ─────────────────────────────────────────────────────────────
section "4 · PERPS DEPTH – before any orders"
# ─────────────────────────────────────────────────────────────
run_test "GET /perps/depth/$PERPS_MARKET – empty book → 200" GET "/perps/depth/$PERPS_MARKET" 200
DEPTH_EMPTY=$(_curl_json GET "/perps/depth/$PERPS_MARKET")
assert_body "Perps depth bids empty at start"  '.bids | length' "0" "$DEPTH_EMPTY"
assert_body "Perps depth asks empty at start"  '.asks | length' "0" "$DEPTH_EMPTY"

# invalid perps market → engine should return error → 400
run_test "GET /perps/depth/INVALID – not a perps market → 400" GET /perps/depth/INVALID 400
run_test "GET /perps/depth/ETH_USD – not in perps → 400"       GET /perps/depth/ETH_USD 400
run_test "GET /perps/depth/btc_usd – lowercase → 400"          GET "/perps/depth/btc_usd" 400

# ─────────────────────────────────────────────────────────────
section "5 · PERPS ORDER – auth guards"
# ─────────────────────────────────────────────────────────────
run_test "POST /perps/order/ – no auth → 401"       POST /perps/order/ 401 \
    "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":30000,\"quantity\":1}"
run_test "POST /perps/order/cancel – no auth → 401" POST /perps/order/cancel 401 \
    "{\"market\":\"$PERPS_MARKET\",\"orderId\":\"some-id\"}"
run_test "GET /perps/order/some-id – no auth → 401" GET /perps/order/some-id 401

# ─────────────────────────────────────────────────────────────
section "6 · PERPS ORDER – Zod input validation (no engine call)"
# createOrderSchema: market(min1), side(buy|sell), price(>0), quantity(>0),
#                    orderType(limit|market, default limit), leverage(>0, default 1)
# cancelOrderSchema: market(min1), orderId(min1)
# ─────────────────────────────────────────────────────────────
run_test "POST /perps/order – missing market → 400"         POST /perps/order/ 400 \
    '{"side":"buy","price":30000,"quantity":1}' "$TOKEN_A"
run_test "POST /perps/order – empty market → 400"           POST /perps/order/ 400 \
    '{"market":"","side":"buy","price":30000,"quantity":1}' "$TOKEN_A"
run_test "POST /perps/order – invalid side 'long' → 400"    POST /perps/order/ 400 \
    "{\"market\":\"$PERPS_MARKET\",\"side\":\"long\",\"price\":30000,\"quantity\":1}" "$TOKEN_A"
run_test "POST /perps/order – invalid side 'short' → 400"   POST /perps/order/ 400 \
    "{\"market\":\"$PERPS_MARKET\",\"side\":\"short\",\"price\":30000,\"quantity\":1}" "$TOKEN_A"
run_test "POST /perps/order – missing side → 400"           POST /perps/order/ 400 \
    "{\"market\":\"$PERPS_MARKET\",\"price\":30000,\"quantity\":1}" "$TOKEN_A"
run_test "POST /perps/order – negative price → 400"         POST /perps/order/ 400 \
    "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":-1,\"quantity\":1}" "$TOKEN_A"
run_test "POST /perps/order – zero price → 400"             POST /perps/order/ 400 \
    "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":0,\"quantity\":1}" "$TOKEN_A"
run_test "POST /perps/order – string price → 400"           POST /perps/order/ 400 \
    "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":\"30000\",\"quantity\":1}" "$TOKEN_A"
run_test "POST /perps/order – negative quantity → 400"      POST /perps/order/ 400 \
    "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":30000,\"quantity\":-1}" "$TOKEN_A"
run_test "POST /perps/order – zero quantity → 400"          POST /perps/order/ 400 \
    "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":30000,\"quantity\":0}" "$TOKEN_A"
run_test "POST /perps/order – missing quantity → 400"       POST /perps/order/ 400 \
    "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":30000}" "$TOKEN_A"
run_test "POST /perps/order – invalid orderType 'stop' → 400" POST /perps/order/ 400 \
    "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":30000,\"quantity\":1,\"orderType\":\"stop\"}" "$TOKEN_A"
# Leverage-specific Zod validation
run_test "POST /perps/order – leverage=0 → 400 (not positive)" POST /perps/order/ 400 \
    "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":30000,\"quantity\":1,\"leverage\":0}" "$TOKEN_A"
run_test "POST /perps/order – leverage=-1 → 400 (not positive)" POST /perps/order/ 400 \
    "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":30000,\"quantity\":1,\"leverage\":-1}" "$TOKEN_A"
run_test "POST /perps/order – leverage=string → 400"        POST /perps/order/ 400 \
    "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":30000,\"quantity\":1,\"leverage\":\"5x\"}" "$TOKEN_A"
run_test "POST /perps/order – empty body → 400"             POST /perps/order/ 400 \
    '{}' "$TOKEN_A"

# Cancel schema
run_test "POST /perps/order/cancel – missing market → 400"  POST /perps/order/cancel 400 \
    '{"orderId":"some-id"}' "$TOKEN_A"
run_test "POST /perps/order/cancel – empty market → 400"    POST /perps/order/cancel 400 \
    '{"market":"","orderId":"some-id"}' "$TOKEN_A"
run_test "POST /perps/order/cancel – missing orderId → 400" POST /perps/order/cancel 400 \
    "{\"market\":\"$PERPS_MARKET\"}" "$TOKEN_A"
run_test "POST /perps/order/cancel – empty orderId → 400"   POST /perps/order/cancel 400 \
    "{\"market\":\"$PERPS_MARKET\",\"orderId\":\"\"}" "$TOKEN_A"
run_test "POST /perps/order/cancel – empty body → 400"      POST /perps/order/cancel 400 \
    '{}' "$TOKEN_A"

# ─────────────────────────────────────────────────────────────
section "7 · PERPS ORDER – engine error scenarios"
# ─────────────────────────────────────────────────────────────

# Invalid perps market — engine should reject
run_test "POST /perps/order – invalid market DOGE_USD → HTTP 200 + engine error" \
    POST /perps/order/ 200 \
    '{"market":"DOGE_USD","side":"buy","price":1,"quantity":1,"orderType":"limit"}' "$TOKEN_A"
INVALID_MKT_RESP=$(_curl_json POST /perps/order/ \
    -H "Authorization: Bearer $TOKEN_A" \
    -d '{"market":"DOGE_USD","side":"buy","price":1,"quantity":1,"orderType":"limit"}')
assert_true "Invalid perps market: response contains error key" \
    'has("error")' "$INVALID_MKT_RESP"

# Insufficient USD balance — fresh user has $0, no deposit
run_test "POST /perps/order – fresh user (0 USD) limit buy → HTTP 200 + engine error" \
    POST /perps/order/ 200 \
    "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":30000,\"quantity\":1}" "$TOKEN_FRESH"
INSUF_RESP=$(_curl_json POST /perps/order/ \
    -H "Authorization: Bearer $TOKEN_FRESH" \
    -d "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":30000,\"quantity\":1}")
assert_true "Insufficient USD: response contains error key" \
    'has("error")' "$INSUF_RESP"

# Huge order way beyond balance
HUGE_RESP=$(_curl_json POST /perps/order/ \
    -H "Authorization: Bearer $TOKEN_A" \
    -d "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":99999,\"quantity\":999999,\"leverage\":1}")
assert_true "Massive order beyond balance: response contains error key" \
    'has("error")' "$HUGE_RESP"

# ─────────────────────────────────────────────────────────────
section "8 · CORE MATCH LIFECYCLE – limit order → fill → position"
# Flow: B places limit sell (opens SHORT) → A places limit buy (crosses, opens LONG)
# No leverage here (leverage=1) to keep margin math simple.
# Price: $30,000 | Qty: 1 BTC_USD
# ─────────────────────────────────────────────────────────────
USD_A_BEFORE=$(_curl_json GET /perps/balance -H "Authorization: Bearer $TOKEN_A" | jq -r '.balance.USD // 0')
USD_B_BEFORE=$(_curl_json GET /perps/balance -H "Authorization: Bearer $TOKEN_B" | jq -r '.balance.USD // 0')

# 8a: User B places limit SELL (resting on ask side)
SELL_RESP=$(_curl_json POST /perps/order/ \
    -H "Authorization: Bearer $TOKEN_B" \
    -d "{\"market\":\"$PERPS_MARKET\",\"side\":\"sell\",\"price\":30000,\"quantity\":1,\"orderType\":\"limit\",\"leverage\":1}")
SELL_ORDER_ID=$(printf '%s' "$SELL_RESP" | jq -r '.orderId // empty')
TOTAL=$((TOTAL + 1))
if [ -n "$SELL_ORDER_ID" ] && [ "$SELL_ORDER_ID" != "null" ]; then
    PASS=$((PASS + 1))
    printf "  ${GREEN}PASS${NC}  %-68s orderId=%s\n" "Limit sell placed (user B, 1 BTC_USD @ \$30k)" "$SELL_ORDER_ID"
else
    FAIL=$((FAIL + 1))
    printf "  ${RED}FAIL${NC}  %-68s no orderId — engine down?\n" "Limit sell placed (user B, 1 BTC_USD @ \$30k)"
    printf "        ${RED}body: %s${NC}\n" "$(printf '%s' "$SELL_RESP" | head -c 200)"
fi
printf '%s\n' "$(jq -n --arg n "Limit sell placed (user B)" --arg m POST --arg p "/perps/order/" \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$SELL_ORDER_ID" ] && [ "$SELL_ORDER_ID" != "null" ] && echo true || echo false)" \
    --argjson body "$(printf '%s' "$SELL_RESP" | jq -c . 2>/dev/null || echo '""')" \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# 8b: Verify depth shows the ask before fill
DEPTH_BEFORE=$(_curl_json GET "/perps/depth/$PERPS_MARKET")
assert_body "Depth: resting sell visible in asks"   '.asks | length > 0' "true"  "$DEPTH_BEFORE"
assert_body "Depth: best ask price = 30000"         '.asks[0].price'     "30000" "$DEPTH_BEFORE"
assert_body "Depth: bids side still empty"          '.bids | length'     "0"     "$DEPTH_BEFORE"

# 8c: User A places limit BUY that crosses the ask (price >= ask → fills)
BUY_RESP=$(_curl_json POST /perps/order/ \
    -H "Authorization: Bearer $TOKEN_A" \
    -d "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":31000,\"quantity\":1,\"orderType\":\"limit\",\"leverage\":1}")
BUY_ORDER_ID=$(printf '%s' "$BUY_RESP" | jq -r '.orderId // empty')
TOTAL=$((TOTAL + 1))
if [ -n "$BUY_ORDER_ID" ] && [ "$BUY_ORDER_ID" != "null" ]; then
    PASS=$((PASS + 1))
    printf "  ${GREEN}PASS${NC}  %-68s orderId=%s\n" "Crossing limit buy placed (user A, 1 BTC_USD @ \$31k)" "$BUY_ORDER_ID"
else
    FAIL=$((FAIL + 1))
    printf "  ${RED}FAIL${NC}  %-68s no orderId — engine down?\n" "Crossing limit buy placed (user A, 1 BTC_USD @ \$31k)"
    printf "        ${RED}body: %s${NC}\n" "$(printf '%s' "$BUY_RESP" | head -c 200)"
fi
printf '%s\n' "$(jq -n --arg n "Crossing limit buy placed (user A)" --arg m POST --arg p "/perps/order/" \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$BUY_ORDER_ID" ] && [ "$BUY_ORDER_ID" != "null" ] && echo true || echo false)" \
    --argjson body "$(printf '%s' "$BUY_RESP" | jq -c . 2>/dev/null || echo '""')" \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# 8d: verify sell order is FILLED
if [ -n "$SELL_ORDER_ID" ] && [ "$SELL_ORDER_ID" != "null" ]; then
    SELL_ORDER=$(_curl_json GET "/perps/order/$SELL_ORDER_ID" -H "Authorization: Bearer $TOKEN_B")
    assert_body "Sell order status = FILLED"    '.status'         "FILLED" "$SELL_ORDER"
    assert_body "Sell order filledQuantity = 1" '.filledQuantity' "1"      "$SELL_ORDER"
fi

# 8e: verify buy order is FILLED (maker fill at $30k even though limit was $31k)
if [ -n "$BUY_ORDER_ID" ] && [ "$BUY_ORDER_ID" != "null" ]; then
    BUY_ORDER=$(_curl_json GET "/perps/order/$BUY_ORDER_ID" -H "Authorization: Bearer $TOKEN_A")
    assert_body "Buy order status = FILLED"              '.status'         "FILLED" "$BUY_ORDER"
    assert_body "Buy order filledQuantity = 1"           '.filledQuantity' "1"      "$BUY_ORDER"
    assert_body "Buy order fill price = 30000 (maker)"   '.avgPrice'       "30000"  "$BUY_ORDER"
fi

# 8f: depth is empty after both sides filled
DEPTH_AFTER=$(_curl_json GET "/perps/depth/$PERPS_MARKET")
assert_body "Depth bids empty after full fill" '.bids | length' "0" "$DEPTH_AFTER"
assert_body "Depth asks empty after full fill" '.asks | length' "0" "$DEPTH_AFTER"

# ─────────────────────────────────────────────────────────────
section "9 · POSITION READS – after lifecycle fill"
# ─────────────────────────────────────────────────────────────

# 9a: User A should have a LONG position on BTC_USD
run_test "GET /perps/position/$PERPS_MARKET – user A has position → 200" \
    GET "/perps/position/$PERPS_MARKET" 200 "" "$TOKEN_A"
POS_A=$(_curl_json GET "/perps/position/$PERPS_MARKET" -H "Authorization: Bearer $TOKEN_A")
assert_body "User A position: side = LONG"          '.side'   "LONG"      "$POS_A"
assert_body "User A position: status = OPEN"        '.status' "OPEN"      "$POS_A"
assert_body "User A position: market = BTC_USD"     '.market' "BTC_USD"   "$POS_A"
assert_body "User A position: entryPrice = 30000"   '.entryPrice' "30000" "$POS_A"
assert_true "User A position: margin > 0"           '.margin > 0'          "$POS_A"
assert_true "User A position: liquidationPrice > 0" '.liquidationPrice > 0' "$POS_A"
# For LONG with leverage=1, liquidationPrice should be < entryPrice (liquidated if price drops to ~0)
assert_true "User A LONG: liquidationPrice < entryPrice" \
    '.liquidationPrice < .entryPrice' "$POS_A"

# 9b: User A all positions — should contain BTC_USD
run_test "GET /perps/positions/ – user A → 200" GET /perps/positions/ 200 "" "$TOKEN_A"
ALL_POS_A=$(_curl_json GET /perps/positions/ -H "Authorization: Bearer $TOKEN_A")
# response can be array or object — check BTC_USD key/element exists
assert_true "User A all positions: BTC_USD entry present" \
    '(type == "array" and (.[].market == "BTC_USD") or (type == "object" and has("BTC_USD")))' \
    "$ALL_POS_A"

# 9c: User B should have a SHORT position
run_test "GET /perps/position/$PERPS_MARKET – user B has position → 200" \
    GET "/perps/position/$PERPS_MARKET" 200 "" "$TOKEN_B"
POS_B=$(_curl_json GET "/perps/position/$PERPS_MARKET" -H "Authorization: Bearer $TOKEN_B")
assert_body "User B position: side = SHORT"         '.side'   "SHORT"   "$POS_B"
assert_body "User B position: status = OPEN"        '.status' "OPEN"    "$POS_B"
assert_body "User B position: entryPrice = 30000"   '.entryPrice' "30000" "$POS_B"
assert_true "User B position: margin > 0"           '.margin > 0'  "$POS_B"
# For SHORT with leverage=1, liquidationPrice should be > entryPrice
assert_true "User B SHORT: liquidationPrice > entryPrice" \
    '.liquidationPrice > .entryPrice' "$POS_B"

# 9d: Fresh user has no position → engine should return empty or error
run_test "GET /perps/position/$PERPS_MARKET – fresh user (no position) → 400" \
    GET "/perps/position/$PERPS_MARKET" 400 "" "$TOKEN_FRESH"
FRESH_POS=$(_curl_json GET "/perps/position/$PERPS_MARKET" -H "Authorization: Bearer $TOKEN_FRESH")
# Engine may return null, {}, {error:...}, or an empty position — just verify no crash
assert_true "Fresh user: no OPEN position returned" \
    '(.status != "OPEN") or (. == null) or (. == {})' "$FRESH_POS"

# 9e: All positions for fresh user — should be empty
run_test "GET /perps/positions/ – fresh user → 200" GET /perps/positions/ 200 "" "$TOKEN_FRESH"

# 9f: Invalid market
run_test "GET /perps/position/INVALID – bad market → 400" \
    GET /perps/position/INVALID 400 "" "$TOKEN_A"

# ─────────────────────────────────────────────────────────────
section "10 · LEVERAGE SCENARIOS"
# User C has $200k USD, no existing position.
# Test that leverage correctly controls margin deduction.
# margin = (price × quantity) / leverage
# ─────────────────────────────────────────────────────────────

# 10a: leverage=5 — seller side (user C shorts 1 BTC @ $30k, margin = $30k/5 = $6k)
USD_C_BEFORE=$(_curl_json GET /perps/balance -H "Authorization: Bearer $TOKEN_C" | jq -r '.balance.USD // 0')

# First place a resting ask from a counterparty (user A, who already has a position
# — their second order creates a second position or adds to existing depending on engine impl)
# Instead, use user B (who is SHORT) to place a BUY limit, then C sells into it
LEV_SETUP_BUY=$(_curl_json POST /perps/order/ \
    -H "Authorization: Bearer $TOKEN_B" \
    -d "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":30000,\"quantity\":1,\"orderType\":\"limit\",\"leverage\":1}")
LEV_SETUP_BUY_ID=$(printf '%s' "$LEV_SETUP_BUY" | jq -r '.orderId // empty')

# User C sells 1 BTC @ $29,500 with leverage=5 (crosses the resting bid at $30k)
LEV5_RESP=$(_curl_json POST /perps/order/ \
    -H "Authorization: Bearer $TOKEN_C" \
    -d "{\"market\":\"$PERPS_MARKET\",\"side\":\"sell\",\"price\":29500,\"quantity\":1,\"orderType\":\"limit\",\"leverage\":5}")
LEV5_ORDER_ID=$(printf '%s' "$LEV5_RESP" | jq -r '.orderId // empty')
TOTAL=$((TOTAL + 1))
if [ -n "$LEV5_ORDER_ID" ] && [ "$LEV5_ORDER_ID" != "null" ]; then
    PASS=$((PASS + 1))
    printf "  ${GREEN}PASS${NC}  %-68s orderId=%s\n" "Leverage=5 sell placed (user C, 1 BTC @ \$29.5k)" "$LEV5_ORDER_ID"

    # After fill, user C should have a SHORT position with margin ~= $30,000 / 5 = $6,000
    POS_C=$(_curl_json GET "/perps/position/$PERPS_MARKET" -H "Authorization: Bearer $TOKEN_C")
    assert_body "Leverage=5 position: side=SHORT"   '.side'   "SHORT" "$POS_C"
    assert_body "Leverage=5 position: status=OPEN"  '.status' "OPEN"  "$POS_C"
    assert_true "Leverage=5 position: margin > 0"   '.margin > 0'     "$POS_C"
    # margin should be roughly notional/5 (±fees/rounding), i.e. around $6,000
    # We check it's less than the full notional ($30,000) and greater than $1
    assert_true "Leverage=5: margin < notional (margin deducted is 1/5 not full amount)" \
        '.margin < 30000' "$POS_C"
    assert_true "Leverage=5: margin > 1000 (sanity — at least some fraction of notional)" \
        '.margin > 1000' "$POS_C"

    # Balance should have decreased by approximately the margin, not the full notional
    USD_C_AFTER=$(_curl_json GET /perps/balance -H "Authorization: Bearer $TOKEN_C" | jq -r '.balance.USD // 0')
    TOTAL=$((TOTAL + 1))
    MARGIN_DEDUCTED=$(echo "$USD_C_BEFORE - $USD_C_AFTER" | bc 2>/dev/null || echo "0")
    # Margin deducted should be much less than $30,000 (it's ~$6,000 for leverage=5)
    if command -v bc >/dev/null 2>&1 && [ "$MARGIN_DEDUCTED" != "0" ]; then
        if (( $(echo "$MARGIN_DEDUCTED < 30000" | bc -l) )); then
            PASS=$((PASS + 1))
            printf "  ${GREEN}PASS${NC}  %-68s margin_deducted=%s (< notional 30000)\n" \
                "Leverage=5: only margin locked (not full notional)" "$MARGIN_DEDUCTED"
        else
            FAIL=$((FAIL + 1))
            printf "  ${RED}FAIL${NC}  %-68s margin_deducted=%s expected < 30000\n" \
                "Leverage=5: only margin locked (not full notional)" "$MARGIN_DEDUCTED"
        fi
        printf '%s\n' "$(jq -n --arg n "Leverage=5 margin deducted check" --arg m "ASSERT" --arg p "(balance delta)" \
            --arg e "<30000" --arg a "$MARGIN_DEDUCTED" \
            --argjson passed "$(echo "$MARGIN_DEDUCTED < 30000" | bc -l 2>/dev/null | grep -q 1 && echo true || echo false)" \
            '{name:$n,method:$m,path:$p,expected_status:0,actual_status:0,passed:$passed,response:{margin_deducted:$a}}'
        )" >> "$TMP"
    fi
else
    FAIL=$((FAIL + 1))
    printf "  ${RED}FAIL${NC}  %-68s no orderId — engine may be down or counterparty order not resting\n" \
        "Leverage=5 sell placed (user C)"
    printf "        ${RED}body: %s${NC}\n" "$(printf '%s' "$LEV5_RESP" | head -c 200)"
fi
printf '%s\n' "$(jq -n --arg n "Leverage=5 sell (user C)" --arg m POST --arg p "/perps/order/" \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$LEV5_ORDER_ID" ] && [ "$LEV5_ORDER_ID" != "null" ] && echo true || echo false)" \
    --argjson body "$(printf '%s' "$LEV5_RESP" | jq -c . 2>/dev/null || echo '""')" \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# 10b: leverage omitted — should default to 1 (Zod default)
LEV_DEFAULT_RESP=$(_curl_json POST /perps/order/ \
    -H "Authorization: Bearer $TOKEN_A" \
    -d "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":25000,\"quantity\":1,\"orderType\":\"limit\"}")
LEV_DEFAULT_ID=$(printf '%s' "$LEV_DEFAULT_RESP" | jq -r '.orderId // empty')
# Validate via assert_body (avoids placing a second uncancelled order via run_test)
assert_body "POST /perps/order – leverage omitted defaults to 1 (reaches engine)" \
    '.leverage' "1" "$LEV_DEFAULT_RESP"
# clean up the resting bid
if [ -n "$LEV_DEFAULT_ID" ] && [ "$LEV_DEFAULT_ID" != "null" ]; then
    _curl_json POST /perps/order/cancel \
        -H "Authorization: Bearer $TOKEN_A" \
        -d "{\"market\":\"$PERPS_MARKET\",\"orderId\":\"$LEV_DEFAULT_ID\"}" > /dev/null 2>&1 || true
fi

# 10c: leverage=100 (very high — Zod allows >0; capture and cancel to keep book clean)
LEV100_RESP=$(_curl_json POST /perps/order/ \
    -H "Authorization: Bearer $TOKEN_A" \
    -d "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":25000,\"quantity\":1,\"orderType\":\"limit\",\"leverage\":100}")
LEV100_ID=$(printf '%s' "$LEV100_RESP" | jq -r '.orderId // empty')
assert_body "POST /perps/order – leverage=100 passes Zod (engine decides limit)" \
    '.leverage' "100" "$LEV100_RESP"
if [ -n "$LEV100_ID" ] && [ "$LEV100_ID" != "null" ]; then
    _curl_json POST /perps/order/cancel \
        -H "Authorization: Bearer $TOKEN_A" \
        -d "{\"market\":\"$PERPS_MARKET\",\"orderId\":\"$LEV100_ID\"}" > /dev/null 2>&1 || true
fi

# ─────────────────────────────────────────────────────────────
section "11 · CANCEL SCENARIOS"
# ─────────────────────────────────────────────────────────────

# 11a: Place a fresh limit order that won't fill, then cancel it
CANCEL_SELL_RESP=$(_curl_json POST /perps/order/ \
    -H "Authorization: Bearer $TOKEN_B" \
    -d "{\"market\":\"$PERPS_MARKET\",\"side\":\"sell\",\"price\":50000,\"quantity\":1,\"orderType\":\"limit\",\"leverage\":1}")
CANCEL_SELL_ID=$(printf '%s' "$CANCEL_SELL_RESP" | jq -r '.orderId // empty')
TOTAL=$((TOTAL + 1))
if [ -n "$CANCEL_SELL_ID" ] && [ "$CANCEL_SELL_ID" != "null" ]; then
    PASS=$((PASS + 1))
    printf "  ${GREEN}PASS${NC}  %-68s orderId=%s\n" "Resting sell placed for cancel test (user B, \$50k)" "$CANCEL_SELL_ID"

    # Verify it shows as OPEN in getOrder
    CANCEL_BEFORE=$(_curl_json GET "/perps/order/$CANCEL_SELL_ID" -H "Authorization: Bearer $TOKEN_B")
    assert_body "Cancel test: order initially OPEN"     '.status' "OPEN" "$CANCEL_BEFORE"
    assert_body "Cancel test: depth shows the ask"      '.asks | length > 0' "true" \
        "$(_curl_json GET "/perps/depth/$PERPS_MARKET")"

    # Cancel it
    CANCEL_RESP=$(_curl_json POST /perps/order/cancel \
        -H "Authorization: Bearer $TOKEN_B" \
        -d "{\"market\":\"$PERPS_MARKET\",\"orderId\":\"$CANCEL_SELL_ID\"}")
    assert_body "Cancel: status = CANCELLED"            '.status'         "CANCELLED" "$CANCEL_RESP"
    assert_body "Cancel: filledQuantity = 0"            '.filledQuantity' "0"         "$CANCEL_RESP"

    # Depth should no longer show that order
    DEPTH_AFTER_CANCEL=$(_curl_json GET "/perps/depth/$PERPS_MARKET")
    assert_body "Cancel: ask side cleared after cancel" '.asks | length' "0" "$DEPTH_AFTER_CANCEL"

    # 11b: double-cancel → engine error
    DOUBLE_CANCEL=$(_curl_json POST /perps/order/cancel \
        -H "Authorization: Bearer $TOKEN_B" \
        -d "{\"market\":\"$PERPS_MARKET\",\"orderId\":\"$CANCEL_SELL_ID\"}")
    assert_true "Double-cancel: error key present" 'has("error")' "$DOUBLE_CANCEL"
else
    FAIL=$((FAIL + 1))
    printf "  ${RED}FAIL${NC}  %-68s no orderId\n" "Resting sell placed for cancel test"
fi
printf '%s\n' "$(jq -n --arg n "Resting sell for cancel test (user B, \$50k)" --arg m POST --arg p "/perps/order/" \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$CANCEL_SELL_ID" ] && [ "$CANCEL_SELL_ID" != "null" ] && echo true || echo false)" \
    --argjson body "$(printf '%s' "$CANCEL_SELL_RESP" | jq -c . 2>/dev/null || echo '""')" \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# 11c: cancel a FILLED order → engine error
if [ -n "$SELL_ORDER_ID" ] && [ "$SELL_ORDER_ID" != "null" ]; then
    CANCEL_FILLED=$(_curl_json POST /perps/order/cancel \
        -H "Authorization: Bearer $TOKEN_B" \
        -d "{\"market\":\"$PERPS_MARKET\",\"orderId\":\"$SELL_ORDER_ID\"}")
    assert_true "Cancel FILLED order: error key present" 'has("error")' "$CANCEL_FILLED"
fi

# ─────────────────────────────────────────────────────────────
section "12 · MARKET ORDER EDGE CASES"
# ─────────────────────────────────────────────────────────────

# Ensure book is empty (no resting orders) before these tests
# (already cleaned up above)

# 12a: market buy with empty ask book → should be CANCELLED immediately
MKT_BUY_EMPTY=$(_curl_json POST /perps/order/ \
    -H "Authorization: Bearer $TOKEN_A" \
    -d "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":999999,\"quantity\":1,\"orderType\":\"market\"}")
MKT_BUY_EMPTY_ID=$(printf '%s' "$MKT_BUY_EMPTY" | jq -r '.orderId // empty')
TOTAL=$((TOTAL + 1))
if [ -n "$MKT_BUY_EMPTY_ID" ] && [ "$MKT_BUY_EMPTY_ID" != "null" ]; then
    PASS=$((PASS + 1))
    printf "  ${GREEN}PASS${NC}  %-68s orderId=%s\n" "Market buy on empty perps book" "$MKT_BUY_EMPTY_ID"
    assert_body "Market buy empty book: CANCELLED"      '.status'         "CANCELLED" "$MKT_BUY_EMPTY"
    assert_body "Market buy empty book: filledQty=0"    '.filledQuantity' "0"         "$MKT_BUY_EMPTY"
else
    FAIL=$((FAIL + 1))
    printf "  ${RED}FAIL${NC}  %-68s body: %s\n" "Market buy on empty perps book" \
        "$(printf '%s' "$MKT_BUY_EMPTY" | head -c 200)"
fi
printf '%s\n' "$(jq -n --arg n "Market buy on empty perps book → CANCELLED" --arg m POST --arg p "/perps/order/" \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$MKT_BUY_EMPTY_ID" ] && [ "$MKT_BUY_EMPTY_ID" != "null" ] && echo true || echo false)" \
    --argjson body "$(printf '%s' "$MKT_BUY_EMPTY" | jq -c . 2>/dev/null || echo '""')" \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# 12b: market sell with empty bid book → CANCELLED
MKT_SELL_EMPTY=$(_curl_json POST /perps/order/ \
    -H "Authorization: Bearer $TOKEN_B" \
    -d "{\"market\":\"$PERPS_MARKET\",\"side\":\"sell\",\"price\":1,\"quantity\":1,\"orderType\":\"market\"}")
MKT_SELL_EMPTY_ID=$(printf '%s' "$MKT_SELL_EMPTY" | jq -r '.orderId // empty')
TOTAL=$((TOTAL + 1))
if [ -n "$MKT_SELL_EMPTY_ID" ] && [ "$MKT_SELL_EMPTY_ID" != "null" ]; then
    PASS=$((PASS + 1))
    printf "  ${GREEN}PASS${NC}  %-68s orderId=%s\n" "Market sell on empty perps book" "$MKT_SELL_EMPTY_ID"
    assert_body "Market sell empty book: CANCELLED"     '.status'         "CANCELLED" "$MKT_SELL_EMPTY"
    assert_body "Market sell empty book: filledQty=0"   '.filledQuantity' "0"         "$MKT_SELL_EMPTY"
else
    FAIL=$((FAIL + 1))
    printf "  ${RED}FAIL${NC}  %-68s body: %s\n" "Market sell on empty perps book" \
        "$(printf '%s' "$MKT_SELL_EMPTY" | head -c 200)"
fi
printf '%s\n' "$(jq -n --arg n "Market sell on empty perps book → CANCELLED" --arg m POST --arg p "/perps/order/" \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$MKT_SELL_EMPTY_ID" ] && [ "$MKT_SELL_EMPTY_ID" != "null" ] && echo true || echo false)" \
    --argjson body "$(printf '%s' "$MKT_SELL_EMPTY" | jq -c . 2>/dev/null || echo '""')" \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# 12c: partial market fill → PARTIALLY_CANCELLED
# Place 1 resting ask, market buy for 3 → fills 1, cancels remaining 2
PART_ASK=$(_curl_json POST /perps/order/ \
    -H "Authorization: Bearer $TOKEN_B" \
    -d "{\"market\":\"$PERPS_MARKET\",\"side\":\"sell\",\"price\":31000,\"quantity\":1,\"orderType\":\"limit\",\"leverage\":1}")
PART_ASK_ID=$(printf '%s' "$PART_ASK" | jq -r '.orderId // empty')
if [ -n "$PART_ASK_ID" ] && [ "$PART_ASK_ID" != "null" ]; then
    MKT_PART=$(_curl_json POST /perps/order/ \
        -H "Authorization: Bearer $TOKEN_A" \
        -d "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":999999,\"quantity\":3,\"orderType\":\"market\"}")
    MKT_PART_ID=$(printf '%s' "$MKT_PART" | jq -r '.orderId // empty')
    TOTAL=$((TOTAL + 1))
    if [ -n "$MKT_PART_ID" ] && [ "$MKT_PART_ID" != "null" ]; then
        PASS=$((PASS + 1))
        printf "  ${GREEN}PASS${NC}  %-68s orderId=%s\n" "Market buy partial fill (want 3, 1 resting)" "$MKT_PART_ID"
        assert_body "Market partial: status=PARTIALLY_CANCELLED" '.status'         "PARTIALLY_CANCELLED" "$MKT_PART"
        assert_body "Market partial: filledQuantity=1"           '.filledQuantity' "1"                   "$MKT_PART"
        assert_body "Market partial: 1 fill recorded"            '.fills | length' "1"                   "$MKT_PART"
    else
        FAIL=$((FAIL + 1))
        printf "  ${RED}FAIL${NC}  %-68s body: %s\n" "Market buy partial fill" \
            "$(printf '%s' "$MKT_PART" | head -c 200)"
    fi
    printf '%s\n' "$(jq -n --arg n "Market buy partial fill → PARTIALLY_CANCELLED" --arg m POST --arg p "/perps/order/" \
        --arg e "200" --arg a "200" \
        --argjson passed "$([ -n "$MKT_PART_ID" ] && [ "$MKT_PART_ID" != "null" ] && echo true || echo false)" \
        --argjson body "$(printf '%s' "$MKT_PART" | jq -c . 2>/dev/null || echo '""')" \
        '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
    )" >> "$TMP"
fi

# ─────────────────────────────────────────────────────────────
section "13 · QUEUE ISOLATION – perps ↔ spot do not bleed"
# ─────────────────────────────────────────────────────────────
printf "  ${YELLOW}NOTE: perps orders must NOT appear in spot depth and vice versa.${NC}\n"

# Place a resting perps bid; the spot depth for BTC_USD should be unaffected
ISOL_BID=$(_curl_json POST /perps/order/ \
    -H "Authorization: Bearer $TOKEN_A" \
    -d "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":20000,\"quantity\":1,\"orderType\":\"limit\",\"leverage\":1}")
ISOL_BID_ID=$(printf '%s' "$ISOL_BID" | jq -r '.orderId // empty')

if [ -n "$ISOL_BID_ID" ] && [ "$ISOL_BID_ID" != "null" ]; then
    # Perps depth should show the bid
    ISOL_PERPS_DEPTH=$(_curl_json GET "/perps/depth/$PERPS_MARKET")
    assert_body "Isolation: perps bid visible in perps depth" '.bids | length > 0' "true" "$ISOL_PERPS_DEPTH"

    # Spot depth for same market must NOT see the perps order
    ISOL_SPOT_DEPTH=$(_curl_json GET "/spot/depth/$PERPS_MARKET")
    assert_body "Isolation: spot depth empty (perps order not bleeding in)" '.bids | length' "0" "$ISOL_SPOT_DEPTH"

    # Clean up
    _curl_json POST /perps/order/cancel \
        -H "Authorization: Bearer $TOKEN_A" \
        -d "{\"market\":\"$PERPS_MARKET\",\"orderId\":\"$ISOL_BID_ID\"}" > /dev/null 2>&1 || true
fi

# Place a spot order; should not show in perps depth
ISOL_SPOT_BID=$(_curl_json POST /spot/order/ \
    -H "Authorization: Bearer $TOKEN_A" \
    -d "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":19000,\"quantity\":1,\"orderType\":\"limit\"}")
ISOL_SPOT_BID_ID=$(printf '%s' "$ISOL_SPOT_BID" | jq -r '.orderId // empty')

if [ -n "$ISOL_SPOT_BID_ID" ] && [ "$ISOL_SPOT_BID_ID" != "null" ]; then
    ISOL_PERPS_AFTER=$(_curl_json GET "/perps/depth/$PERPS_MARKET")
    assert_body "Isolation: spot order not visible in perps depth" '.bids | length' "0" "$ISOL_PERPS_AFTER"

    # Clean up
    _curl_json POST /spot/order/cancel \
        -H "Authorization: Bearer $TOKEN_A" \
        -d "{\"market\":\"$PERPS_MARKET\",\"orderId\":\"$ISOL_SPOT_BID_ID\"}" > /dev/null 2>&1 || true
fi

# ─────────────────────────────────────────────────────────────
section "14 · GET ORDER – error scenarios"
# ─────────────────────────────────────────────────────────────

# Nonexistent order id → engine error body (HTTP 200)
run_test "GET /perps/order/nonexistent-uuid → HTTP 200 + engine error" \
    GET /perps/order/00000000-0000-0000-0000-000000000000 200 "" "$TOKEN_A"
NOEX_ORDER=$(_curl_json GET /perps/order/00000000-0000-0000-0000-000000000000 \
    -H "Authorization: Bearer $TOKEN_A")
assert_true "Get nonexistent perps order: error key present" 'has("error")' "$NOEX_ORDER"

# Cancel nonexistent order → engine error
run_test "POST /perps/order/cancel – nonexistent orderId → HTTP 200 + engine error" \
    POST /perps/order/cancel 200 \
    "{\"market\":\"$PERPS_MARKET\",\"orderId\":\"00000000-0000-0000-0000-000000000000\"}" "$TOKEN_A"

# Access another user's order (user A tries to GET user B's order)
if [ -n "$SELL_ORDER_ID" ] && [ "$SELL_ORDER_ID" != "null" ]; then
    CROSS_RESP=$(_curl_json GET "/perps/order/$SELL_ORDER_ID" -H "Authorization: Bearer $TOKEN_A")
    # Engine may return error or the order without user check — note the actual behaviour
    TOTAL=$((TOTAL + 1))
    CROSS_STATUS=$(printf '%s' "$CROSS_RESP" | jq -r '.status // "null"')
    if [ "$CROSS_STATUS" = "null" ] || printf '%s' "$CROSS_RESP" | jq -e 'has("error")' > /dev/null 2>&1; then
        PASS=$((PASS + 1))
        printf "  ${GREEN}PASS${NC}  %-68s cross-user order blocked or not found\n" "Cross-user order access: engine rejects or not found"
    else
        FAIL=$((FAIL + 1))
        printf "  ${RED}FAIL${NC}  %-68s order returned for wrong user (status=%s) — potential privacy bug\n" \
            "Cross-user order access: should not return other user's order" "$CROSS_STATUS"
    fi
    printf '%s\n' "$(jq -n --arg n "Cross-user order access (user A gets user B order)" --arg m GET \
        --arg p "/perps/order/$SELL_ORDER_ID" --arg e "200" --arg a "200" \
        --argjson passed "$(printf '%s' "$CROSS_RESP" | jq -e 'has("error")' > /dev/null 2>&1 && echo true || echo false)" \
        --argjson body "$(printf '%s' "$CROSS_RESP" | jq -c . 2>/dev/null || echo '""')" \
        '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
    )" >> "$TMP"
fi

# ─────────────────────────────────────────────────────────────
section "15 · BALANCE ACCOUNTING – verify margin deducted after fill"
# Leverage=1, price=$30k, qty=1 → margin = $30k
# User A's balance should have dropped by $30k vs the $200k initial deposit
# (minus any earlier trades in this run, so we verify the direction, not the exact number)
# ─────────────────────────────────────────────────────────────
USD_A_AFTER=$(_curl_json GET /perps/balance -H "Authorization: Bearer $TOKEN_A" | jq -r '.balance.USD // 0')
TOTAL=$((TOTAL + 1))
# After at least one filled perps trade (leverage=1 @ $30k), balance must be less than initial
if command -v bc >/dev/null 2>&1 && \
   [ "$USD_A_BEFORE" != "0" ] && [ "$USD_A_AFTER" != "0" ]; then
    if (( $(echo "$USD_A_AFTER < $USD_A_BEFORE" | bc -l) )); then
        PASS=$((PASS + 1))
        printf "  ${GREEN}PASS${NC}  %-68s before=%s after=%s\n" \
            "Balance accounting: USD decreased after perps trade" "$USD_A_BEFORE" "$USD_A_AFTER"
    else
        FAIL=$((FAIL + 1))
        printf "  ${RED}FAIL${NC}  %-68s before=%s after=%s (balance should decrease)\n" \
            "Balance accounting: USD decreased after perps trade" "$USD_A_BEFORE" "$USD_A_AFTER"
    fi
    printf '%s\n' "$(jq -n --arg n "Balance accounting: USD decreased after perps trade" \
        --arg m "ASSERT" --arg p "(balance delta)" --arg e "USD_after < USD_before" \
        --arg a "before=$USD_A_BEFORE after=$USD_A_AFTER" \
        --argjson passed "$(echo "$USD_A_AFTER < $USD_A_BEFORE" | bc -l 2>/dev/null | grep -q 1 && echo true || echo false)" \
        '{name:$n,method:$m,path:$p,expected_status:0,actual_status:0,passed:$passed,response:$a}'
    )" >> "$TMP"
else
    # bc not available — just check via jq comparison
    BAL_RESP=$(_curl_json GET /perps/balance -H "Authorization: Bearer $TOKEN_A")
    assert_true "Balance accounting: USD decreased after perps trade" \
        "(.balance.USD // 200000) < 200000" "$BAL_RESP"
fi

# ─────────────────────────────────────────────────────────────
section "16 · ORDER STATUS TRANSITIONS via GET /perps/order/:id"
# Place sell (3 qty). Partially fill 1, verify PARTIALLY_FILLED.
# Fill remaining 2, verify FILLED. All via perps queue.
# ─────────────────────────────────────────────────────────────
TRANS_SELL=$(_curl_json POST /perps/order/ \
    -H "Authorization: Bearer $TOKEN_B" \
    -d "{\"market\":\"$PERPS_MARKET\",\"side\":\"sell\",\"price\":32000,\"quantity\":3,\"orderType\":\"limit\",\"leverage\":1}")
TRANS_SELL_ID=$(printf '%s' "$TRANS_SELL" | jq -r '.orderId // empty')
TOTAL=$((TOTAL + 1))
if [ -n "$TRANS_SELL_ID" ] && [ "$TRANS_SELL_ID" != "null" ]; then
    PASS=$((PASS + 1))
    printf "  ${GREEN}PASS${NC}  %-68s\n" "Status transition: 3-qty sell placed (user B @ \$32k)"

    # initial state
    T1=$(_curl_json GET "/perps/order/$TRANS_SELL_ID" -H "Authorization: Bearer $TOKEN_B")
    assert_body "Status: fresh order is OPEN"            '.status'         "OPEN" "$T1"
    assert_body "Status: filledQuantity starts at 0"    '.filledQuantity' "0"    "$T1"

    # partial fill: buy 1
    _curl_json POST /perps/order/ -H "Authorization: Bearer $TOKEN_A" \
        -d "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":33000,\"quantity\":1,\"orderType\":\"limit\",\"leverage\":1}" \
        > /dev/null 2>&1 || true
    T2=$(_curl_json GET "/perps/order/$TRANS_SELL_ID" -H "Authorization: Bearer $TOKEN_B")
    assert_body "Status: after 1-of-3 fill → PARTIALLY_FILLED" '.status'         "PARTIALLY_FILLED" "$T2"
    assert_body "Status: filledQuantity=1 after partial fill"   '.filledQuantity' "1"                "$T2"

    # full fill: buy remaining 2
    _curl_json POST /perps/order/ -H "Authorization: Bearer $TOKEN_A" \
        -d "{\"market\":\"$PERPS_MARKET\",\"side\":\"buy\",\"price\":33000,\"quantity\":2,\"orderType\":\"limit\",\"leverage\":1}" \
        > /dev/null 2>&1 || true
    T3=$(_curl_json GET "/perps/order/$TRANS_SELL_ID" -H "Authorization: Bearer $TOKEN_B")
    assert_body "Status: after full fill → FILLED"              '.status'         "FILLED"           "$T3"
    assert_body "Status: filledQuantity=3 when fully filled"    '.filledQuantity' "3"                "$T3"
    assert_true "Status: fills array has at least 1 entry"      '.fills | length >= 1'               "$T3"
else
    FAIL=$((FAIL + 1))
    printf "  ${RED}FAIL${NC}  %-68s no orderId\n" "Status transition: 3-qty sell placed"
fi
printf '%s\n' "$(jq -n --arg n "Status transition test (OPEN→PARTIALLY_FILLED→FILLED)" \
    --arg m POST --arg p "/perps/order/" --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$TRANS_SELL_ID" ] && [ "$TRANS_SELL_ID" != "null" ] && echo true || echo false)" \
    --argjson body "$(printf '%s' "$TRANS_SELL" | jq -c . 2>/dev/null || echo '""')" \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# ─────────────────────────────────────────────────────────────
section "17 · PERPS-ONLY SANITY CHECKS"
# ─────────────────────────────────────────────────────────────

# spot deposit still works (perps didn't break it)
run_test "POST /spot/deposit – still works after perps activity" POST /spot/deposit 200 \
    '{"asset":"USD","amount":1}' "$TOKEN_A"

# spot balance and perps balance return same value (same store)
SPOT_BAL=$(_curl_json GET /spot/balance -H "Authorization: Bearer $TOKEN_A" | jq -r '.USD // "x"')
PERPS_BAL=$(_curl_json GET /perps/balance -H "Authorization: Bearer $TOKEN_A" | jq -r '.balance.USD // "y"')
TOTAL=$((TOTAL + 1))
if [ "$SPOT_BAL" = "$PERPS_BAL" ]; then
    PASS=$((PASS + 1))
    printf "  ${GREEN}PASS${NC}  %-68s spot_USD=%s perps_USD=%s\n" \
        "Shared balance: /spot/balance == /perps/balance for same user" "$SPOT_BAL" "$PERPS_BAL"
else
    FAIL=$((FAIL + 1))
    printf "  ${RED}FAIL${NC}  %-68s spot=%s perps=%s (should be identical)\n" \
        "Shared balance: /spot/balance == /perps/balance for same user" "$SPOT_BAL" "$PERPS_BAL"
fi
printf '%s\n' "$(jq -n --arg n "Shared balance: spot==perps USD" --arg m "ASSERT" \
    --arg p "(balance comparison)" --arg e "$SPOT_BAL" --arg a "$PERPS_BAL" \
    --argjson passed "$([ "$SPOT_BAL" = "$PERPS_BAL" ] && echo true || echo false)" \
    '{name:$n,method:$m,path:$p,expected_status:0,actual_status:0,passed:$passed,response:{spot_USD:$e,perps_USD:$a}}'
)" >> "$TMP"

# GET /perps/positions/ returns same-or-similar structure as GET /perps/position/:market
# (just verifying it reaches the engine and returns 200, content checked in section 9)
run_test "GET /perps/positions/ – user B → 200 (has SHORT position)" \
    GET /perps/positions/ 200 "" "$TOKEN_B"
ALL_POS_B=$(_curl_json GET /perps/positions/ -H "Authorization: Bearer $TOKEN_B")
assert_true "User B all positions: BTC_USD entry present" \
    '(type == "array" and (.[].market == "BTC_USD")) or (type == "object" and has("BTC_USD"))' \
    "$ALL_POS_B"

# ─────────────────────────────────────────────────────────────
section "18 · MISC"
# ─────────────────────────────────────────────────────────────
run_test "GET /db-check – returns user count"           GET /db-check 200
run_test "GET /debug/ping-engine – engine reachable"    GET /debug/ping-engine 200
run_test "GET /health – still healthy after full suite" GET /health 200

# =============================================================
# FINAL SUMMARY
# =============================================================
LAST_SECTION_MS_FINAL=$LAST_SECTION_MS
printf "  ${YELLOW}└─ section took %d ms${NC}\n" "$(( $(date +%s%3N 2>/dev/null || echo 0) - LAST_SECTION_MS_FINAL ))"
printf "\n%.70s\n" "══════════════════════════════════════════════════════════════════════"
printf "  Total: %d  │  ${GREEN}Pass: %d${NC}  │  ${RED}Fail: %d${NC}\n" "$TOTAL" "$PASS" "$FAIL"
printf "%.70s\n" "══════════════════════════════════════════════════════════════════════"

SUITE_DURATION_MS=$(( $(date +%s%3N 2>/dev/null || echo 0) - SUITE_START_MS ))
jq -n \
    --arg run_at   "$RUN_AT" \
    --arg base_url "$BASE_URL" \
    --argjson total "$TOTAL" \
    --argjson pass  "$PASS" \
    --argjson fail  "$FAIL" \
    --argjson suite_duration_ms "$SUITE_DURATION_MS" \
    --slurpfile tests "$TMP" \
    '{
        run_at:   $run_at,
        base_url: $base_url,
        suite:    "perps",
        summary: {
            total: $total,
            pass:  $pass,
            fail:  $fail,
            pass_rate: (if $total > 0 then (($pass / $total * 1000 | round) / 10) else 0 end),
            duration_ms: $suite_duration_ms
        },
        tests: $tests
    }' > "$RESULT_FILE"

printf "  Results saved → %s  (suite took %d ms)\n\n" "$RESULT_FILE" "$SUITE_DURATION_MS"

[ "$FAIL" -gt 0 ] && exit 1 || exit 0
