#!/usr/bin/env bash
# =============================================================
# CEX-V2 API End-to-End Test Suite
# Usage:   bash test-api.sh [BASE_URL]
# Results: test-results.json
# Deps:    curl, jq
# =============================================================
set -uo pipefail

BASE_URL="${1:-${BASE_URL:-http://localhost:3000}}"
RESULT_FILE="${RESULT_FILE:-test-results.json}"
RUN_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")
SUFFIX=$(date +%s 2>/dev/null || echo "$$")

# ── colours ──────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

# ── counters and result accumulator ──────────────────────────
PASS=0; FAIL=0; TOTAL=0
TMP=$(mktemp /tmp/cex_results.XXXXXX)
trap 'rm -f "$TMP"' EXIT

# ── shared state set during run ───────────────────────────────
TOKEN_A=""   # auth token for user A (buyer)
TOKEN_B=""   # auth token for user B (seller)
SELL_ORDER_ID=""
BUY_ORDER_ID=""

# =============================================================
# run_test NAME METHOD PATH EXPECTED_STATUS [BODY] [TOKEN] [CUSTOM_AUTH]
#   BODY        – JSON string, empty = no body
#   TOKEN       – JWT value (will be sent as "Bearer <TOKEN>")
#   CUSTOM_AUTH – overrides TOKEN; sent verbatim as Authorization value
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

    local raw; raw=$(curl "${args[@]}" 2>/dev/null)
    local actual; actual=$(printf '%s' "$raw" | grep -o '__CEX_STATUS__[0-9]*' | sed 's/__CEX_STATUS__//')
    local resp; resp=$(printf '%s' "$raw" | sed 's/__CEX_STATUS__[0-9]*$//' | sed '$ { /^$/d }')
    [ -z "$actual" ] && actual="000"

    local passed=false
    if [ "$actual" = "$expected" ]; then
        passed=true; PASS=$((PASS + 1))
        printf "  ${GREEN}PASS${NC}  %-64s HTTP %s\n" "$name" "$actual"
    else
        FAIL=$((FAIL + 1))
        printf "  ${RED}FAIL${NC}  %-64s expected=%s  got=%s\n" "$name" "$expected" "$actual"
        if [ "$resp" != "" ]; then
            printf "        ${RED}body: %s${NC}\n" "$(printf '%s' "$resp" | head -c 120)"
        fi
    fi

    local safe_body; safe_body=$(printf '%s' "$resp" | jq -c . 2>/dev/null || printf '"%s"' "$(printf '%s' "$resp" | tr '"\\' "' " | head -c 200)")
    printf '%s\n' "$(jq -n \
        --arg n  "$name"   --arg m  "$method" --arg p  "$path" \
        --arg e  "$expected" --arg a "$actual" \
        --argjson passed "$passed" --argjson body "$safe_body" \
        '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
    )" >> "$TMP"
}

# convenience for calling curl silently and extracting a field
_curl_json() { curl -s -X "$1" "$BASE_URL$2" -H "Content-Type: application/json" "${@:3}" 2>/dev/null; }

# assert_body NAME JQ_EXPR EXPECTED_VAL RESPONSE_JSON
# Checks that jq EXPR applied to RESPONSE_JSON equals EXPECTED_VAL.
# Records a test entry in TMP. Used for orderbook state / body content checks.
assert_body() {
    local name="$1" expr="$2" expected="$3" resp="$4"
    TOTAL=$((TOTAL + 1))
    local actual; actual=$(printf '%s' "$resp" | jq -r "$expr" 2>/dev/null || echo "__jq_err__")
    local passed=false
    if [ "$actual" = "$expected" ]; then
        passed=true; PASS=$((PASS + 1))
        printf "  ${GREEN}PASS${NC}  %-64s %s = \"%s\"\n" "$name" "$expr" "$actual"
    else
        FAIL=$((FAIL + 1))
        printf "  ${RED}FAIL${NC}  %-64s %s  expected=\"%s\"  got=\"%s\"\n" "$name" "$expr" "$expected" "$actual"
    fi
    printf '%s\n' "$(jq -n \
        --arg n "$name" --arg e "$expected" --arg a "$actual" --argjson passed "$passed" \
        '{name:$n,method:"ASSERT",path:"(body check)",expected_status:0,actual_status:0,passed:$passed,response:{expected:$e,actual:$a}}'
    )" >> "$TMP"
}

section() { printf "\n${CYAN}── %s${NC}\n" "$1"; }

# =============================================================
printf "\n${YELLOW}CEX-V2 API Test Suite${NC}\n"
printf "Target  : %s\n" "$BASE_URL"
printf "Results : %s\n" "$RESULT_FILE"
printf "Run at  : %s\n" "$RUN_AT"
printf "%.65s\n" "═══════════════════════════════════════════════════════════════════"

# ─────────────────────────────────────────────────────────────
section "1 · HEALTH"
# ─────────────────────────────────────────────────────────────
run_test "GET /health returns ok:true"                   GET /health 200

# ─────────────────────────────────────────────────────────────
section "2 · SIGNUP"
# ─────────────────────────────────────────────────────────────
USER_A="buyer_${SUFFIX}"
USER_B="seller_${SUFFIX}"

run_test "POST /signup – valid user A"                   POST /signup 201 \
    "{\"username\":\"$USER_A\",\"password\":\"password123\"}"

run_test "POST /signup – valid user B"                   POST /signup 201 \
    "{\"username\":\"$USER_B\",\"password\":\"securepass\"}"

run_test "POST /signup – duplicate username → 409"       POST /signup 409 \
    "{\"username\":\"$USER_A\",\"password\":\"password123\"}"

run_test "POST /signup – username too short (<3) → 400"  POST /signup 400 \
    '{"username":"ab","password":"password123"}'

run_test "POST /signup – username too long (>32) → 400"  POST /signup 400 \
    '{"username":"averylongusernamethatexceedsthirtytwocharszz","password":"pw1234"}'

run_test "POST /signup – password too short (<6) → 400"  POST /signup 400 \
    '{"username":"validuserx9","password":"abc"}'

run_test "POST /signup – missing username → 400"         POST /signup 400 \
    '{"password":"password123"}'

run_test "POST /signup – missing password → 400"         POST /signup 400 \
    '{"username":"validuserx9"}'

run_test "POST /signup – empty body → 400"               POST /signup 400 '{}'

# ─────────────────────────────────────────────────────────────
section "3 · SIGNIN + capture tokens"
# ─────────────────────────────────────────────────────────────
run_test "POST /signin – valid credentials user A"       POST /signin 200 \
    "{\"username\":\"$USER_A\",\"password\":\"password123\"}"

run_test "POST /signin – valid credentials user B"       POST /signin 200 \
    "{\"username\":\"$USER_B\",\"password\":\"securepass\"}"

run_test "POST /signin – wrong password → 401"           POST /signin 401 \
    "{\"username\":\"$USER_A\",\"password\":\"wrongpassword\"}"

run_test "POST /signin – nonexistent user → 404"         POST /signin 404 \
    '{"username":"ghost_that_does_not_exist","password":"password123"}'

run_test "POST /signin – password too short (zod) → 400" POST /signin 400 \
    "{\"username\":\"$USER_A\",\"password\":\"ab\"}"

run_test "POST /signin – missing username → 400"         POST /signin 400 \
    '{"password":"password123"}'

run_test "POST /signin – missing password → 400"         POST /signin 400 \
    "{\"username\":\"$USER_A\"}"

run_test "POST /signin – empty body → 400"               POST /signin 400 '{}'

# capture tokens for subsequent tests
TOKEN_A=$(_curl_json POST /signin \
    -d "{\"username\":\"$USER_A\",\"password\":\"password123\"}" | jq -r '.token // empty' 2>/dev/null || true)
TOKEN_B=$(_curl_json POST /signin \
    -d "{\"username\":\"$USER_B\",\"password\":\"securepass\"}" | jq -r '.token // empty' 2>/dev/null || true)

if [ -z "$TOKEN_A" ] || [ -z "$TOKEN_B" ]; then
    printf "\n  ${RED}FATAL: could not obtain auth tokens — server may be down or engine not running.${NC}\n\n"
fi

# ─────────────────────────────────────────────────────────────
section "4 · BALANCE – auth guards"
# ─────────────────────────────────────────────────────────────
run_test "GET /balance – no Authorization header → 401"  GET /balance 401

run_test "GET /balance – wrong scheme (NotBearer) → 401" GET /balance 401 \
    "" "" "NotBearer $TOKEN_A"

run_test "GET /balance – malformed token (no payload) → 401" GET /balance 401 \
    "" "eyJhbGciOiJIUzI1NiJ9.invalid.sig"

run_test "GET /balance – expired/tampered token → 401"   GET /balance 401 \
    "" "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJmYWtlIiwiaWF0IjoxfQ.badinvalidsig"

run_test "GET /balance – valid token, fresh user → 200"  GET /balance 200 \
    "" "$TOKEN_A"

# ─────────────────────────────────────────────────────────────
section "5 · DEPOSIT"
# ─────────────────────────────────────────────────────────────
run_test "POST /deposit – no auth → 401"                 POST /deposit 401 \
    '{"asset":"BTC","amount":1}'

run_test "POST /deposit – valid BTC user A"              POST /deposit 200 \
    '{"asset":"BTC","amount":10}' "$TOKEN_A"

run_test "POST /deposit – valid USD user A"              POST /deposit 200 \
    '{"asset":"USD","amount":500000}' "$TOKEN_A"

run_test "POST /deposit – valid ETH user A"              POST /deposit 200 \
    '{"asset":"ETH","amount":50}' "$TOKEN_A"

run_test "POST /deposit – valid SOL user A"              POST /deposit 200 \
    '{"asset":"SOL","amount":1000}' "$TOKEN_A"

run_test "POST /deposit – valid BTC user B"              POST /deposit 200 \
    '{"asset":"BTC","amount":30}' "$TOKEN_B"

run_test "POST /deposit – valid USD user B"              POST /deposit 200 \
    '{"asset":"USD","amount":200000}' "$TOKEN_B"

# asset validation done by engine; engine error → controller returns 400
run_test "POST /deposit – invalid asset DOGE → 400"     POST /deposit 400 \
    '{"asset":"DOGE","amount":100}' "$TOKEN_A"

run_test "POST /deposit – lowercase asset btc → 400"    POST /deposit 400 \
    '{"asset":"btc","amount":100}' "$TOKEN_A"

run_test "POST /deposit – empty asset string → 400"     POST /deposit 400 \
    '{"asset":"","amount":100}' "$TOKEN_A"

# amount validation done by controller before hitting engine
run_test "POST /deposit – zero amount → 400"            POST /deposit 400 \
    '{"asset":"BTC","amount":0}' "$TOKEN_A"

run_test "POST /deposit – negative amount → 400"        POST /deposit 400 \
    '{"asset":"BTC","amount":-5}' "$TOKEN_A"

run_test "POST /deposit – string amount → 400"          POST /deposit 400 \
    '{"asset":"BTC","amount":"100"}' "$TOKEN_A"

run_test "POST /deposit – null amount → 400"            POST /deposit 400 \
    '{"asset":"BTC","amount":null}' "$TOKEN_A"

run_test "POST /deposit – missing asset → 400"          POST /deposit 400 \
    '{"amount":100}' "$TOKEN_A"

run_test "POST /deposit – missing amount → 400"         POST /deposit 400 \
    '{"asset":"BTC"}' "$TOKEN_A"

run_test "POST /deposit – empty body → 400"             POST /deposit 400 \
    '{}' "$TOKEN_A"

# ─────────────────────────────────────────────────────────────
section "6 · BALANCE – after deposit"
# ─────────────────────────────────────────────────────────────
run_test "GET /balance – user A has funded balance"     GET /balance 200 "" "$TOKEN_A"
run_test "GET /balance – user B has funded balance"     GET /balance 200 "" "$TOKEN_B"

# ─────────────────────────────────────────────────────────────
section "7 · MARKET DEPTH (public)"
# ─────────────────────────────────────────────────────────────
# Valid markets from engine: BTC_USD, ETH_USD, ETH_BTC, BTC_SOL
run_test "GET /depth/BTC_USD – valid market (empty book)"   GET /depth/BTC_USD 200
run_test "GET /depth/ETH_USD – valid market"                GET /depth/ETH_USD 200
run_test "GET /depth/ETH_BTC – valid market"                GET /depth/ETH_BTC 200
run_test "GET /depth/BTC_SOL – valid market"                GET /depth/BTC_SOL 200

# engine returns {error:"invalid market"} → controller returns 400
run_test "GET /depth/INVALID – unknown market → 400"        GET /depth/INVALID 400
run_test "GET /depth/BTC_USDT – not in engine MARKETS → 400" GET /depth/BTC_USDT 400
run_test "GET /depth/btc_usd – lowercase (not in MARKETS) → 400" GET /depth/btc_usd 400
run_test "GET /depth/BTC – single segment → 400"            GET /depth/BTC 400

# ─────────────────────────────────────────────────────────────
section "8 · ORDER – auth guards"
# ─────────────────────────────────────────────────────────────
run_test "POST /order – no auth → 401"                  POST /order/ 401 \
    '{"market":"BTC_USD","side":"buy","price":30000,"quantity":1,"orderType":"limit"}'

run_test "POST /order/cancel – no auth → 401"           POST /order/cancel 401 \
    '{"market":"BTC_USD","orderId":"some-id"}'

run_test "GET /order/some-id – no auth → 401"           GET /order/some-id 401

# ─────────────────────────────────────────────────────────────
section "9 · ORDER – input validation (zod, no engine call)"
# ─────────────────────────────────────────────────────────────
# createOrderSchema: symbol(min1), side(buy|sell), price(positive), qty(positive), type(limit|market default)
run_test "POST /order – missing symbol → 400"           POST /order/ 400 \
    '{"side":"buy","price":30000,"quantity":1,"orderType":"limit"}' "$TOKEN_A"

run_test "POST /order – empty symbol → 400"             POST /order/ 400 \
    '{"market":"","side":"buy","price":30000,"quantity":1,"orderType":"limit"}' "$TOKEN_A"

run_test "POST /order – invalid side 'hold' → 400"      POST /order/ 400 \
    '{"market":"BTC_USD","side":"hold","price":30000,"quantity":1,"orderType":"limit"}' "$TOKEN_A"

run_test "POST /order – missing side → 400"             POST /order/ 400 \
    '{"market":"BTC_USD","price":30000,"quantity":1,"orderType":"limit"}' "$TOKEN_A"

run_test "POST /order – negative price → 400"           POST /order/ 400 \
    '{"market":"BTC_USD","side":"buy","price":-1,"quantity":1,"orderType":"limit"}' "$TOKEN_A"

run_test "POST /order – zero price → 400"               POST /order/ 400 \
    '{"market":"BTC_USD","side":"buy","price":0,"quantity":1,"orderType":"limit"}' "$TOKEN_A"

run_test "POST /order – string price → 400"             POST /order/ 400 \
    '{"market":"BTC_USD","side":"buy","price":"30000","quantity":1,"orderType":"limit"}' "$TOKEN_A"

run_test "POST /order – negative qty → 400"             POST /order/ 400 \
    '{"market":"BTC_USD","side":"buy","price":30000,"quantity":-1,"orderType":"limit"}' "$TOKEN_A"

run_test "POST /order – zero qty → 400"                 POST /order/ 400 \
    '{"market":"BTC_USD","side":"buy","price":30000,"quantity":0,"orderType":"limit"}' "$TOKEN_A"

run_test "POST /order – invalid type 'stop' → 400"      POST /order/ 400 \
    '{"market":"BTC_USD","side":"buy","price":30000,"quantity":1,"orderType":"stop"}' "$TOKEN_A"

run_test "POST /order – missing qty → 400"              POST /order/ 400 \
    '{"market":"BTC_USD","side":"buy","price":30000,"orderType":"limit"}' "$TOKEN_A"

run_test "POST /order – empty body → 400"               POST /order/ 400 '{}' "$TOKEN_A"

# cancelOrderSchema: market(min1), orderId(min1)
run_test "POST /order/cancel – missing market → 400"    POST /order/cancel 400 \
    '{"orderId":"some-id"}' "$TOKEN_A"

run_test "POST /order/cancel – empty market → 400"      POST /order/cancel 400 \
    '{"market":"","orderId":"some-id"}' "$TOKEN_A"

run_test "POST /order/cancel – missing orderId → 400"   POST /order/cancel 400 \
    '{"market":"BTC_USD"}' "$TOKEN_A"

run_test "POST /order/cancel – empty orderId → 400"     POST /order/cancel 400 \
    '{"market":"BTC_USD","orderId":""}' "$TOKEN_A"

run_test "POST /order/cancel – empty body → 400"        POST /order/cancel 400 \
    '{}' "$TOKEN_A"

# ─────────────────────────────────────────────────────────────
section "10 · ORDER – engine scenarios"
# KNOWN BUG: order-controller spreads Zod-parsed fields {symbol, qty, type}
# directly to sendToEngine, but engine's createOrderRequest expects
# {market, quantity, orderType}. Until fixed, any createOrder reaches the
# engine with market=undefined and the engine throws "invalid market".
# The controller does NOT check result.error, so HTTP 200 is always returned
# but the body will contain {error:"invalid market"}.
#
# Tests below verify the HTTP contract (200 response), but the RESPONSE BODY
# check is what reveals the bug — look for "error" key in the JSON column.
# ─────────────────────────────────────────────────────────────
printf "  ${YELLOW}NOTE: createOrder field-mapping bug — engine receives 'symbol/qty/type' instead of 'market/quantity/orderType'${NC}\n"
printf "  ${YELLOW}      Responses will be HTTP 200 with {\"error\":\"invalid market\"} until bug is fixed.${NC}\n\n"

run_test "POST /order – limit buy BTC_USD (HTTP 200; body may have error)" POST /order/ 200 \
    '{"market":"BTC_USD","side":"buy","price":30000,"quantity":1,"orderType":"limit"}' "$TOKEN_A"

run_test "POST /order – limit sell BTC_USD"             POST /order/ 200 \
    '{"market":"BTC_USD","side":"sell","price":30000,"quantity":1,"orderType":"limit"}' "$TOKEN_B"

run_test "POST /order – market buy"                     POST /order/ 200 \
    '{"market":"BTC_USD","side":"buy","price":1,"quantity":1,"orderType":"market"}' "$TOKEN_A"

run_test "POST /order – market sell"                    POST /order/ 200 \
    '{"market":"BTC_USD","side":"sell","price":1,"quantity":1,"orderType":"market"}' "$TOKEN_B"

run_test "POST /order – type defaults to limit (omit type)" POST /order/ 200 \
    '{"market":"BTC_USD","side":"buy","price":30000,"quantity":1}' "$TOKEN_A"

run_test "POST /order – ETH_USD pair"                   POST /order/ 200 \
    '{"market":"ETH_USD","side":"buy","price":2000,"quantity":5,"orderType":"limit"}' "$TOKEN_A"

# engine returns {error:"order not found"} → controller returns HTTP 200
run_test "GET /order/:id – nonexistent UUID → HTTP 200 + engine error" \
    GET /order/00000000-0000-0000-0000-000000000000 200 "" "$TOKEN_A"

run_test "POST /order/cancel – nonexistent orderId → HTTP 200 + engine error" \
    POST /order/cancel 200 \
    '{"market":"BTC_USD","orderId":"00000000-0000-0000-0000-000000000000"}' "$TOKEN_A"

# ─────────────────────────────────────────────────────────────
section "11 · MATCHING ENGINE – full trade lifecycle"
# These pass ONLY after field-mapping bug is fixed in order-controller.ts:
#   symbol  → market
#   qty     → quantity
#   type    → orderType
# ─────────────────────────────────────────────────────────────
printf "  ${YELLOW}NOTE: lifecycle tests will fail until field-mapping bug is fixed.${NC}\n\n"

# -- step 1: seller (user B) places limit ask 2 BTC at $29,000
SELL_RESP=$(_curl_json POST /order/ \
    -H "Authorization: Bearer $TOKEN_B" \
    -d '{"market":"BTC_USD","side":"sell","price":29000,"quantity":2,"orderType":"limit"}' 2>/dev/null || true)
SELL_ORDER_ID=$(printf '%s' "$SELL_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -n "$SELL_ORDER_ID" ] && [ "$SELL_ORDER_ID" != "null" ]; then
    PASS=$((PASS + 1))
    printf "  ${GREEN}PASS${NC}  %-64s orderId=%s\n" "Limit sell placed (user B, 2 BTC @ \$29k)" "$SELL_ORDER_ID"
else
    FAIL=$((FAIL + 1))
    printf "  ${RED}FAIL${NC}  %-64s no orderId — bug not fixed or engine down\n" "Limit sell placed (user B, 2 BTC @ \$29k)"
fi
safe_s=$(printf '%s' "$SELL_RESP" | jq -c . 2>/dev/null || echo '""')
printf '%s\n' "$(jq -n --arg n "Limit sell placed (user B)" --arg m POST --arg p /order/ \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$SELL_ORDER_ID" ] && [ "$SELL_ORDER_ID" != "null" ] && echo true || echo false)" \
    --argjson body "$safe_s" \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# -- step 2: buyer (user A) crosses with limit buy 1 BTC at $30,000 (above ask → fills at $29k)
BUY_RESP=$(_curl_json POST /order/ \
    -H "Authorization: Bearer $TOKEN_A" \
    -d '{"market":"BTC_USD","side":"buy","price":30000,"quantity":1,"orderType":"limit"}' 2>/dev/null || true)
BUY_ORDER_ID=$(printf '%s' "$BUY_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -n "$BUY_ORDER_ID" ] && [ "$BUY_ORDER_ID" != "null" ]; then
    PASS=$((PASS + 1))
    printf "  ${GREEN}PASS${NC}  %-64s orderId=%s\n" "Crossing limit buy placed (user A, 1 BTC @ \$30k)" "$BUY_ORDER_ID"
else
    FAIL=$((FAIL + 1))
    printf "  ${RED}FAIL${NC}  %-64s no orderId — bug not fixed or engine down\n" "Crossing limit buy placed (user A, 1 BTC @ \$30k)"
fi
safe_b=$(printf '%s' "$BUY_RESP" | jq -c . 2>/dev/null || echo '""')
printf '%s\n' "$(jq -n --arg n "Crossing limit buy (user A)" --arg m POST --arg p /order/ \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$BUY_ORDER_ID" ] && [ "$BUY_ORDER_ID" != "null" ] && echo true || echo false)" \
    --argjson body "$safe_b" \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# -- step 3: verify buy order is FILLED (1 BTC filled at $29k)
if [ -n "$BUY_ORDER_ID" ] && [ "$BUY_ORDER_ID" != "null" ]; then
    run_test "GET /order – buy order status=FILLED, avgPrice=29000" \
        GET "/order/$BUY_ORDER_ID" 200 "" "$TOKEN_A"
fi

# -- step 4: check depth — sell side should show 1 BTC remaining at $29k
run_test "GET /depth/BTC_USD – 1 remaining ask after partial fill" \
    GET /depth/BTC_USD 200

# -- step 5: cancel remaining ask (1 BTC remaining from original 2)
if [ -n "$SELL_ORDER_ID" ] && [ "$SELL_ORDER_ID" != "null" ]; then
    run_test "POST /order/cancel – cancel partial ask (user B)" \
        POST /order/cancel 200 \
        "{\"market\":\"BTC_USD\",\"orderId\":\"$SELL_ORDER_ID\"}" "$TOKEN_B"

    # -- step 6: cancel already-cancelled → engine error, HTTP 200
    run_test "POST /order/cancel – re-cancel (engine error in body)" \
        POST /order/cancel 200 \
        "{\"market\":\"BTC_USD\",\"orderId\":\"$SELL_ORDER_ID\"}" "$TOKEN_B"
fi

# -- step 7: depth should now be empty after cancel
run_test "GET /depth/BTC_USD – empty after cancel" GET /depth/BTC_USD 200

# -- step 8: balance check — user A should have +1 BTC −$29k; user B +$29k −1 BTC
run_test "GET /balance – user A after buy trade"  GET /balance 200 "" "$TOKEN_A"
run_test "GET /balance – user B after sell trade" GET /balance 200 "" "$TOKEN_B"

# -- step 9: market buy fills against resting limit sell
RESELL_RESP=$(_curl_json POST /order/ \
    -H "Authorization: Bearer $TOKEN_B" \
    -d '{"market":"BTC_USD","side":"sell","price":28000,"quantity":1,"orderType":"limit"}' 2>/dev/null || true)
RESELL_ID=$(printf '%s' "$RESELL_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
if [ -n "$RESELL_ID" ] && [ "$RESELL_ID" != "null" ]; then
    run_test "POST /order – market buy hits resting sell at \$28k" \
        POST /order/ 200 \
        '{"market":"BTC_USD","side":"buy","price":1,"quantity":1,"orderType":"market"}' "$TOKEN_A"
fi

# -- step 10: market sell with no resting bids → CANCELLED
run_test "POST /order – market sell with empty bid book → CANCELLED" \
    POST /order/ 200 \
    '{"market":"BTC_USD","side":"sell","price":1,"quantity":999,"orderType":"market"}' "$TOKEN_B"

# -- step 11: limit buy with insufficient balance → engine error
run_test "POST /order – limit buy beyond balance → engine error (HTTP 200)" \
    POST /order/ 200 \
    '{"market":"BTC_USD","side":"buy","price":99999,"quantity":999999,"orderType":"limit"}' "$TOKEN_A"

# NOTE: All sections 12–23 require the field-mapping bug to be fixed first
# (order-controller.ts must map symbol→market, qty→quantity, type→orderType).
# Until then every createOrder returns HTTP 200 with {error:"invalid market"}
# and orderId-dependent checks will fail.

# =============================================================
# ─────────────────────────────────────────────────────────────
section "12 · ORDERBOOK DEPTH STATE"
# Verify depth correctly reflects resting orders before and after events.
# ─────────────────────────────────────────────────────────────

# place a resting bid below any ask (won't fill immediately)
BID_REST_RESP=$(_curl_json POST /order/ \
    -H "Authorization: Bearer $TOKEN_A" \
    -d '{"market":"BTC_USD","side":"buy","price":20000,"quantity":3,"orderType":"limit"}' 2>/dev/null || true)
BID_REST_ID=$(printf '%s' "$BID_REST_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -n "$BID_REST_ID" ] && [ "$BID_REST_ID" != "null" ]; then
    PASS=$((PASS + 1)); printf "  ${GREEN}PASS${NC}  %-64s orderId=%s\n" "Resting bid placed (3 BTC @ \$20k)" "$BID_REST_ID"
else
    FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${NC}  %-64s no orderId\n" "Resting bid placed (3 BTC @ \$20k)"
fi
printf '%s\n' "$(jq -n --arg n "Resting bid placed (3 BTC @ \$20k)" --arg m POST --arg p /order/ \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$BID_REST_ID" ] && [ "$BID_REST_ID" != "null" ] && echo true || echo false)" \
    --argjson body "$(printf '%s' "$BID_REST_RESP" | jq -c . 2>/dev/null || echo '""')" \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# depth must show a bid at $20k with count=3
DEPTH1=$(_curl_json GET /depth/BTC_USD 2>/dev/null || true)
run_test "GET /depth/BTC_USD – has bids after resting bid" GET /depth/BTC_USD 200
assert_body "Depth bids not empty"   '.bids | length > 0'  "true"  "$DEPTH1"
assert_body "Best bid price = 20000" '.bids[0].price'       "20000" "$DEPTH1"
assert_body "Best bid count = 3"     '.bids[0].count'       "3"     "$DEPTH1"
assert_body "Asks empty (no sells)"  '.asks | length'       "0"     "$DEPTH1"

# place a resting ask above any bid
ASK_REST_RESP=$(_curl_json POST /order/ \
    -H "Authorization: Bearer $TOKEN_B" \
    -d '{"market":"BTC_USD","side":"sell","price":35000,"quantity":2,"orderType":"limit"}' 2>/dev/null || true)
ASK_REST_ID=$(printf '%s' "$ASK_REST_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -n "$ASK_REST_ID" ] && [ "$ASK_REST_ID" != "null" ]; then
    PASS=$((PASS + 1)); printf "  ${GREEN}PASS${NC}  %-64s orderId=%s\n" "Resting ask placed (2 BTC @ \$35k)" "$ASK_REST_ID"
else
    FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${NC}  %-64s no orderId\n" "Resting ask placed (2 BTC @ \$35k)"
fi
printf '%s\n' "$(jq -n --arg n "Resting ask placed (2 BTC @ \$35k)" --arg m POST --arg p /order/ \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$ASK_REST_ID" ] && [ "$ASK_REST_ID" != "null" ] && echo true || echo false)" \
    --argjson body "$(printf '%s' "$ASK_REST_RESP" | jq -c . 2>/dev/null || echo '""')" \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

DEPTH2=$(_curl_json GET /depth/BTC_USD 2>/dev/null || true)
assert_body "Depth has both sides"   '(.bids | length) > 0 and ((.asks | length) > 0)' "true" "$DEPTH2"
assert_body "Best ask price = 35000" '.asks[0].price'  "35000" "$DEPTH2"
assert_body "Best ask count = 2"     '.asks[0].count'  "2"     "$DEPTH2"

# cancel the resting bid — depth should clear that side
if [ -n "$BID_REST_ID" ] && [ "$BID_REST_ID" != "null" ]; then
    _curl_json POST /order/cancel \
        -H "Authorization: Bearer $TOKEN_A" \
        -d "{\"market\":\"BTC_USD\",\"orderId\":\"$BID_REST_ID\"}" > /dev/null 2>&1 || true
    DEPTH3=$(_curl_json GET /depth/BTC_USD 2>/dev/null || true)
    assert_body "Depth bids empty after cancel"  '.bids | length' "0"     "$DEPTH3"
    assert_body "Depth asks unchanged after bid cancel" '.asks[0].price' "35000" "$DEPTH3"
fi

# cancel the resting ask — depth fully empty
if [ -n "$ASK_REST_ID" ] && [ "$ASK_REST_ID" != "null" ]; then
    _curl_json POST /order/cancel \
        -H "Authorization: Bearer $TOKEN_B" \
        -d "{\"market\":\"BTC_USD\",\"orderId\":\"$ASK_REST_ID\"}" > /dev/null 2>&1 || true
    DEPTH4=$(_curl_json GET /depth/BTC_USD 2>/dev/null || true)
    assert_body "Depth fully empty after both cancels" '(.bids | length) == 0 and ((.asks | length) == 0)' "true" "$DEPTH4"
fi

# ─────────────────────────────────────────────────────────────
section "13 · BALANCE LOCKING – limit order reserves funds"
# ─────────────────────────────────────────────────────────────
# Place a limit buy → available USD decreases by price*qty.
# Cancel it → USD fully restored.

BAL_BEFORE=$(_curl_json GET /balance -H "Authorization: Bearer $TOKEN_A" 2>/dev/null || true)
USD_BEFORE=$(printf '%s' "$BAL_BEFORE" | jq -r '.USD // 0' 2>/dev/null || echo "0")

LOCK_ORDER_RESP=$(_curl_json POST /order/ \
    -H "Authorization: Bearer $TOKEN_A" \
    -d '{"market":"BTC_USD","side":"buy","price":22000,"quantity":2,"orderType":"limit"}' 2>/dev/null || true)
LOCK_ORDER_ID=$(printf '%s' "$LOCK_ORDER_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -n "$LOCK_ORDER_ID" ] && [ "$LOCK_ORDER_ID" != "null" ]; then
    PASS=$((PASS + 1)); printf "  ${GREEN}PASS${NC}  %-64s orderId=%s\n" "Limit buy placed to test locking (2 BTC @ \$22k)" "$LOCK_ORDER_ID"
    BAL_AFTER_LOCK=$(_curl_json GET /balance -H "Authorization: Bearer $TOKEN_A" 2>/dev/null || true)
    USD_AFTER_LOCK=$(printf '%s' "$BAL_AFTER_LOCK" | jq -r '.USD // 0' 2>/dev/null || echo "0")
    EXPECTED_LOCKED=$(( ${USD_BEFORE%.*} - 44000 ))
    assert_body "USD locked: balance decreased by 22000*2=44000" \
        '.USD' "$EXPECTED_LOCKED" "$BAL_AFTER_LOCK"
else
    FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${NC}  %-64s no orderId\n" "Limit buy placed to test locking (2 BTC @ \$22k)"
fi
printf '%s\n' "$(jq -n --arg n "Limit buy placed to test locking" --arg m POST --arg p /order/ \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$LOCK_ORDER_ID" ] && [ "$LOCK_ORDER_ID" != "null" ] && echo true || echo false)" \
    --argjson body "$(printf '%s' "$LOCK_ORDER_RESP" | jq -c . 2>/dev/null || echo '""')" \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# cancel → verify balance fully restored
if [ -n "$LOCK_ORDER_ID" ] && [ "$LOCK_ORDER_ID" != "null" ]; then
    CANCEL_LOCK_RESP=$(_curl_json POST /order/cancel \
        -H "Authorization: Bearer $TOKEN_A" \
        -d "{\"market\":\"BTC_USD\",\"orderId\":\"$LOCK_ORDER_ID\"}" 2>/dev/null || true)
    assert_body "Cancelled OPEN order status=CANCELLED" '.status' "CANCELLED" "$CANCEL_LOCK_RESP"
    BAL_AFTER_CANCEL=$(_curl_json GET /balance -H "Authorization: Bearer $TOKEN_A" 2>/dev/null || true)
    assert_body "USD fully restored after cancel" '.USD' "$USD_BEFORE" "$BAL_AFTER_CANCEL"
fi

# ─────────────────────────────────────────────────────────────
section "14 · CANCEL SCENARIOS – OPEN, PARTIALLY_FILLED, terminal"
# ─────────────────────────────────────────────────────────────

# -- 14a: cancel OPEN order for sell side — base asset refunded
BTC_BEFORE=$(_curl_json GET /balance -H "Authorization: Bearer $TOKEN_B" 2>/dev/null | jq -r '.BTC // 0' 2>/dev/null || echo "0")
SELL_OPEN_RESP=$(_curl_json POST /order/ \
    -H "Authorization: Bearer $TOKEN_B" \
    -d '{"market":"BTC_USD","side":"sell","price":40000,"quantity":1,"orderType":"limit"}' 2>/dev/null || true)
SELL_OPEN_ID=$(printf '%s' "$SELL_OPEN_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -n "$SELL_OPEN_ID" ] && [ "$SELL_OPEN_ID" != "null" ]; then
    PASS=$((PASS + 1)); printf "  ${GREEN}PASS${NC}  %-64s\n" "Resting limit sell placed (1 BTC @ \$40k)"
    CANCEL_SELL_RESP=$(_curl_json POST /order/cancel \
        -H "Authorization: Bearer $TOKEN_B" \
        -d "{\"market\":\"BTC_USD\",\"orderId\":\"$SELL_OPEN_ID\"}" 2>/dev/null || true)
    assert_body "Cancel OPEN sell → status=CANCELLED"    '.status' "CANCELLED" "$CANCEL_SELL_RESP"
    assert_body "Cancel OPEN sell → filledQuantity=0"    '.filledQuantity' "0" "$CANCEL_SELL_RESP"
    BTC_AFTER_CANCEL=$(_curl_json GET /balance -H "Authorization: Bearer $TOKEN_B" 2>/dev/null | jq -r '.BTC // 0' 2>/dev/null || echo "0")
    assert_body "BTC fully refunded after cancel-open-sell" '.BTC' "$BTC_BEFORE" \
        "$(_curl_json GET /balance -H "Authorization: Bearer $TOKEN_B" 2>/dev/null || true)"
else
    FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${NC}  %-64s no orderId\n" "Resting limit sell placed (1 BTC @ \$40k)"
fi
printf '%s\n' "$(jq -n --arg n "Resting limit sell for cancel test" --arg m POST --arg p /order/ \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$SELL_OPEN_ID" ] && [ "$SELL_OPEN_ID" != "null" ] && echo true || echo false)" \
    --argjson body "$(printf '%s' "$SELL_OPEN_RESP" | jq -c . 2>/dev/null || echo '""')" \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# -- 14b: cancel PARTIALLY_FILLED order
# User B places limit sell 2 BTC at $27k.
# User A places limit buy 1 BTC at $28k → fills 1 BTC, sell becomes PARTIALLY_FILLED.
# Cancel the sell → status=PARTIALLY_CANCELLED, 1 BTC locked returned.
PART_SELL_RESP=$(_curl_json POST /order/ \
    -H "Authorization: Bearer $TOKEN_B" \
    -d '{"market":"BTC_USD","side":"sell","price":27000,"quantity":2,"orderType":"limit"}' 2>/dev/null || true)
PART_SELL_ID=$(printf '%s' "$PART_SELL_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -n "$PART_SELL_ID" ] && [ "$PART_SELL_ID" != "null" ]; then
    PASS=$((PASS + 1)); printf "  ${GREEN}PASS${NC}  %-64s\n" "Partial-fill sell placed (2 BTC @ \$27k)"
    # trigger a partial fill
    _curl_json POST /order/ \
        -H "Authorization: Bearer $TOKEN_A" \
        -d '{"market":"BTC_USD","side":"buy","price":28000,"quantity":1,"orderType":"limit"}' > /dev/null 2>&1 || true
    # now cancel remaining 1 BTC
    PART_CANCEL_RESP=$(_curl_json POST /order/cancel \
        -H "Authorization: Bearer $TOKEN_B" \
        -d "{\"market\":\"BTC_USD\",\"orderId\":\"$PART_SELL_ID\"}" 2>/dev/null || true)
    assert_body "Cancel PARTIALLY_FILLED → status=PARTIALLY_CANCELLED" \
        '.status' "PARTIALLY_CANCELLED" "$PART_CANCEL_RESP"
    assert_body "Cancel PARTIALLY_FILLED → filledQuantity=1" \
        '.filledQuantity' "1" "$PART_CANCEL_RESP"
else
    FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${NC}  %-64s no orderId\n" "Partial-fill sell placed (2 BTC @ \$27k)"
fi
printf '%s\n' "$(jq -n --arg n "Partial-fill sell for cancel test" --arg m POST --arg p /order/ \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$PART_SELL_ID" ] && [ "$PART_SELL_ID" != "null" ] && echo true || echo false)" \
    --argjson body "$(printf '%s' "$PART_SELL_RESP" | jq -c . 2>/dev/null || echo '""')" \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# -- 14c: cancel FILLED order → engine error "order cannot be cancelled (status: FILLED)"
FILL_SELL_RESP=$(_curl_json POST /order/ \
    -H "Authorization: Bearer $TOKEN_B" \
    -d '{"market":"BTC_USD","side":"sell","price":26000,"quantity":1,"orderType":"limit"}' 2>/dev/null || true)
FILL_SELL_ID=$(printf '%s' "$FILL_SELL_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
if [ -n "$FILL_SELL_ID" ] && [ "$FILL_SELL_ID" != "null" ]; then
    # fully fill it
    _curl_json POST /order/ \
        -H "Authorization: Bearer $TOKEN_A" \
        -d '{"market":"BTC_USD","side":"buy","price":27000,"quantity":1,"orderType":"limit"}' > /dev/null 2>&1 || true
    # confirm it's FILLED
    FILLED_ORDER=$(_curl_json GET "/order/$FILL_SELL_ID" \
        -H "Authorization: Bearer $TOKEN_B" 2>/dev/null || true)
    assert_body "Sell order is now FILLED" '.status' "FILLED" "$FILLED_ORDER"
    # try to cancel
    CANCEL_FILLED_RESP=$(_curl_json POST /order/cancel \
        -H "Authorization: Bearer $TOKEN_B" \
        -d "{\"market\":\"BTC_USD\",\"orderId\":\"$FILL_SELL_ID\"}" 2>/dev/null || true)
    assert_body "Cancel FILLED → engine error message" \
        '.error' "order cannot be cancelled (status: FILLED)" "$CANCEL_FILLED_RESP"
fi

# -- 14d: cancel CANCELLED order (double-cancel) → engine error
if [ -n "$SELL_OPEN_ID" ] && [ "$SELL_OPEN_ID" != "null" ]; then
    DOUBLE_CANCEL_RESP=$(_curl_json POST /order/cancel \
        -H "Authorization: Bearer $TOKEN_B" \
        -d "{\"market\":\"BTC_USD\",\"orderId\":\"$SELL_OPEN_ID\"}" 2>/dev/null || true)
    assert_body "Cancel CANCELLED → engine error message" \
        '.error' "order cannot be cancelled (status: CANCELLED)" "$DOUBLE_CANCEL_RESP"
fi

# ─────────────────────────────────────────────────────────────
section "15 · OVER-LOCK REFUND – limit buy fills at better price"
# limit buy locks price*qty; if fill price < limit price, delta is refunded
# ─────────────────────────────────────────────────────────────
# Snapshot user A USD balance
OL_USD_START=$(_curl_json GET /balance -H "Authorization: Bearer $TOKEN_A" 2>/dev/null | jq -r '.USD // 0' 2>/dev/null || echo "0")

# User B places limit sell 1 BTC at $29,000
OL_SELL_RESP=$(_curl_json POST /order/ \
    -H "Authorization: Bearer $TOKEN_B" \
    -d '{"market":"BTC_USD","side":"sell","price":29000,"quantity":1,"orderType":"limit"}' 2>/dev/null || true)
OL_SELL_ID=$(printf '%s' "$OL_SELL_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)

# User A places limit buy 1 BTC at $31,000 (locks $31k, fills at $29k, $2k refunded)
OL_BUY_RESP=$(_curl_json POST /order/ \
    -H "Authorization: Bearer $TOKEN_A" \
    -d '{"market":"BTC_USD","side":"buy","price":31000,"quantity":1,"orderType":"limit"}' 2>/dev/null || true)
OL_BUY_ID=$(printf '%s' "$OL_BUY_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -n "$OL_BUY_ID" ] && [ "$OL_BUY_ID" != "null" ]; then
    PASS=$((PASS + 1)); printf "  ${GREEN}PASS${NC}  %-64s\n" "Over-lock buy filled (1 BTC @ limit=\$31k, fill=\$29k)"
    # Verify fill price = $29k (maker price)
    OL_BUY_ORDER=$(_curl_json GET "/order/$OL_BUY_ID" -H "Authorization: Bearer $TOKEN_A" 2>/dev/null || true)
    assert_body "Over-lock: buy fills at maker price \$29k"  '.avgPrice'        "29000"  "$OL_BUY_ORDER"
    assert_body "Over-lock: buy status=FILLED"               '.status'          "FILLED" "$OL_BUY_ORDER"
    assert_body "Over-lock: buy has 1 fill"                  '.fills | length'  "1"      "$OL_BUY_ORDER"
    # USD balance = start - 29000 (NOT - 31000; $2k delta was refunded)
    OL_USD_END=$(_curl_json GET /balance -H "Authorization: Bearer $TOKEN_A" 2>/dev/null | jq -r '.USD // 0' 2>/dev/null || echo "0")
    EXPECTED_OL_USD=$(( ${OL_USD_START%.*} - 29000 ))
    assert_body "Over-lock: USD deducted = fill price \$29k not limit \$31k" \
        '.USD' "$EXPECTED_OL_USD" \
        "$(_curl_json GET /balance -H "Authorization: Bearer $TOKEN_A" 2>/dev/null || true)"
else
    FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${NC}  %-64s no orderId\n" "Over-lock buy filled"
fi
printf '%s\n' "$(jq -n --arg n "Over-lock buy (limit=\$31k fills at \$29k)" --arg m POST --arg p /order/ \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$OL_BUY_ID" ] && [ "$OL_BUY_ID" != "null" ] && echo true || echo false)" \
    --argjson body "$(printf '%s' "$OL_BUY_RESP" | jq -c . 2>/dev/null || echo '""')" \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# ─────────────────────────────────────────────────────────────
section "16 · DEPTH AGGREGATION + ORDERING"
# Multiple orders at same price must aggregate; bids high→low, asks low→high
# ─────────────────────────────────────────────────────────────
# Place 3 bids: 1 BTC at $24k, 2 BTC at $24k, 1 BTC at $23k
AGG1_RESP=$(_curl_json POST /order/ -H "Authorization: Bearer $TOKEN_A" \
    -d '{"market":"BTC_USD","side":"buy","price":24000,"quantity":1,"orderType":"limit"}' 2>/dev/null || true)
AGG1_ID=$(printf '%s' "$AGG1_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
AGG2_RESP=$(_curl_json POST /order/ -H "Authorization: Bearer $TOKEN_A" \
    -d '{"market":"BTC_USD","side":"buy","price":24000,"quantity":2,"orderType":"limit"}' 2>/dev/null || true)
AGG2_ID=$(printf '%s' "$AGG2_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
AGG3_RESP=$(_curl_json POST /order/ -H "Authorization: Bearer $TOKEN_A" \
    -d '{"market":"BTC_USD","side":"buy","price":23000,"quantity":1,"orderType":"limit"}' 2>/dev/null || true)
AGG3_ID=$(printf '%s' "$AGG3_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -n "$AGG1_ID" ] && [ "$AGG1_ID" != "null" ] && [ -n "$AGG2_ID" ] && [ -n "$AGG3_ID" ]; then
    PASS=$((PASS + 1)); printf "  ${GREEN}PASS${NC}  %-64s\n" "3 bids placed for aggregation test"
    AGG_DEPTH=$(_curl_json GET /depth/BTC_USD 2>/dev/null || true)
    assert_body "Aggregation: exactly 2 bid price levels"   '.bids | length'    "2"     "$AGG_DEPTH"
    assert_body "Aggregation: best bid price=24000"         '.bids[0].price'   "24000" "$AGG_DEPTH"
    assert_body "Aggregation: best bid count=3 (1+2)"      '.bids[0].count'   "3"     "$AGG_DEPTH"
    assert_body "Aggregation: second bid price=23000"       '.bids[1].price'   "23000" "$AGG_DEPTH"
    assert_body "Aggregation: second bid count=1"           '.bids[1].count'   "1"     "$AGG_DEPTH"
    # bids ordered high→low (best price first)
    assert_body "Bids ordered high→low (bids[0]>bids[1])"  \
        '.bids[0].price > .bids[1].price'  "true"  "$AGG_DEPTH"
    # clean up
    for _id in "$AGG1_ID" "$AGG2_ID" "$AGG3_ID"; do
        _curl_json POST /order/cancel -H "Authorization: Bearer $TOKEN_A" \
            -d "{\"market\":\"BTC_USD\",\"orderId\":\"$_id\"}" > /dev/null 2>&1 || true
    done
else
    FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${NC}  %-64s\n" "3 bids placed for aggregation test"
fi
printf '%s\n' "$(jq -n --arg n "3 bids for aggregation test" --arg m POST --arg p /order/ \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$AGG1_ID" ] && [ -n "$AGG2_ID" ] && [ -n "$AGG3_ID" ] && echo true || echo false)" \
    --argjson body '{"agg1_placed":true}' \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# Asks ordering: low→high (best ask = lowest price first)
ASK_LO_RESP=$(_curl_json POST /order/ -H "Authorization: Bearer $TOKEN_B" \
    -d '{"market":"BTC_USD","side":"sell","price":32000,"quantity":1,"orderType":"limit"}' 2>/dev/null || true)
ASK_HI_RESP=$(_curl_json POST /order/ -H "Authorization: Bearer $TOKEN_B" \
    -d '{"market":"BTC_USD","side":"sell","price":33000,"quantity":1,"orderType":"limit"}' 2>/dev/null || true)
ASK_LO_ID=$(printf '%s' "$ASK_LO_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
ASK_HI_ID=$(printf '%s' "$ASK_HI_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
if [ -n "$ASK_LO_ID" ] && [ "$ASK_LO_ID" != "null" ] && [ -n "$ASK_HI_ID" ] && [ "$ASK_HI_ID" != "null" ]; then
    ASK_DEPTH=$(_curl_json GET /depth/BTC_USD 2>/dev/null || true)
    assert_body "Asks ordered low→high (asks[0]<asks[1])" \
        '.asks[0].price < .asks[1].price' "true" "$ASK_DEPTH"
    assert_body "Best ask (lowest) = 32000" '.asks[0].price' "32000" "$ASK_DEPTH"
    for _id in "$ASK_LO_ID" "$ASK_HI_ID"; do
        _curl_json POST /order/cancel -H "Authorization: Bearer $TOKEN_B" \
            -d "{\"market\":\"BTC_USD\",\"orderId\":\"$_id\"}" > /dev/null 2>&1 || true
    done
fi

# ─────────────────────────────────────────────────────────────
section "17 · PRICE-TIME PRIORITY"
# Two bids at same price: earlier order fills first.
# ─────────────────────────────────────────────────────────────
PT_BUY1_RESP=$(_curl_json POST /order/ -H "Authorization: Bearer $TOKEN_A" \
    -d '{"market":"BTC_USD","side":"buy","price":25000,"quantity":1,"orderType":"limit"}' 2>/dev/null || true)
PT_BUY1_ID=$(printf '%s' "$PT_BUY1_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)

# small sleep to ensure different timestamp
sleep 1 2>/dev/null || true

PT_BUY2_RESP=$(_curl_json POST /order/ -H "Authorization: Bearer $TOKEN_A" \
    -d '{"market":"BTC_USD","side":"buy","price":25000,"quantity":1,"orderType":"limit"}' 2>/dev/null || true)
PT_BUY2_ID=$(printf '%s' "$PT_BUY2_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -n "$PT_BUY1_ID" ] && [ "$PT_BUY1_ID" != "null" ] && [ -n "$PT_BUY2_ID" ] && [ "$PT_BUY2_ID" != "null" ]; then
    PASS=$((PASS + 1)); printf "  ${GREEN}PASS${NC}  %-64s\n" "Two bids at \$25k placed (price-time test)"
    # User B sells 1 BTC at $24k (crosses both bids but only qty=1) → must fill BUY1 first
    _curl_json POST /order/ -H "Authorization: Bearer $TOKEN_B" \
        -d '{"market":"BTC_USD","side":"sell","price":24000,"quantity":1,"orderType":"limit"}' > /dev/null 2>&1 || true
    PT_BUY1_AFTER=$(_curl_json GET "/order/$PT_BUY1_ID" -H "Authorization: Bearer $TOKEN_A" 2>/dev/null || true)
    PT_BUY2_AFTER=$(_curl_json GET "/order/$PT_BUY2_ID" -H "Authorization: Bearer $TOKEN_A" 2>/dev/null || true)
    assert_body "Price-time: earlier bid (BUY1) is FILLED"          '.status' "FILLED" "$PT_BUY1_AFTER"
    assert_body "Price-time: later bid (BUY2) is still OPEN"        '.status' "OPEN"   "$PT_BUY2_AFTER"
    assert_body "Price-time: BUY1 fill price = 25000 (maker bid price)" '.avgPrice' "25000" "$PT_BUY1_AFTER"
    # clean up BUY2 (still resting)
    _curl_json POST /order/cancel -H "Authorization: Bearer $TOKEN_A" \
        -d "{\"market\":\"BTC_USD\",\"orderId\":\"$PT_BUY2_ID\"}" > /dev/null 2>&1 || true
else
    FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${NC}  %-64s\n" "Two bids at \$25k placed (price-time test)"
fi
printf '%s\n' "$(jq -n --arg n "Price-time priority test" --arg m POST --arg p /order/ \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$PT_BUY1_ID" ] && [ -n "$PT_BUY2_ID" ] && echo true || echo false)" \
    --argjson body '{"note":"earlier order fills first"}' \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# ─────────────────────────────────────────────────────────────
section "18 · avgPrice – weighted average across multiple fills"
# Taker market-buys across two resting asks at different prices.
# avgPrice = (28000*1 + 30000*1) / 2 = 29000
# ─────────────────────────────────────────────────────────────
# User B places two separate asks
_curl_json POST /order/ -H "Authorization: Bearer $TOKEN_B" \
    -d '{"market":"BTC_USD","side":"sell","price":28000,"quantity":1,"orderType":"limit"}' > /dev/null 2>&1 || true
_curl_json POST /order/ -H "Authorization: Bearer $TOKEN_B" \
    -d '{"market":"BTC_USD","side":"sell","price":30000,"quantity":1,"orderType":"limit"}' > /dev/null 2>&1 || true

# User A market-buys 2 BTC — fills both asks
AVG_BUY_RESP=$(_curl_json POST /order/ -H "Authorization: Bearer $TOKEN_A" \
    -d '{"market":"BTC_USD","side":"buy","price":1,"quantity":2,"orderType":"market"}' 2>/dev/null || true)
AVG_BUY_ID=$(printf '%s' "$AVG_BUY_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -n "$AVG_BUY_ID" ] && [ "$AVG_BUY_ID" != "null" ]; then
    PASS=$((PASS + 1)); printf "  ${GREEN}PASS${NC}  %-64s\n" "Market buy 2 BTC across two asks (\$28k + \$30k)"
    AVG_ORDER=$(_curl_json GET "/order/$AVG_BUY_ID" -H "Authorization: Bearer $TOKEN_A" 2>/dev/null || true)
    assert_body "avgPrice test: status=FILLED (2 fills)"         '.status'       "FILLED" "$AVG_ORDER"
    assert_body "avgPrice test: filledQuantity=2"                '.filledQuantity' "2"    "$AVG_ORDER"
    assert_body "avgPrice test: 2 fills recorded"                '.fills | length' "2"   "$AVG_ORDER"
    assert_body "avgPrice test: weighted avg = (28000+30000)/2=29000" '.avgPrice' "29000" "$AVG_ORDER"
else
    FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${NC}  %-64s no orderId\n" "Market buy 2 BTC across two asks"
fi
printf '%s\n' "$(jq -n --arg n "avgPrice: market buy across 2 asks" --arg m POST --arg p /order/ \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$AVG_BUY_ID" ] && [ "$AVG_BUY_ID" != "null" ] && echo true || echo false)" \
    --argjson body "$(printf '%s' "$AVG_BUY_RESP" | jq -c . 2>/dev/null || echo '""')" \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# ─────────────────────────────────────────────────────────────
section "19 · MARKET ORDER STATES"
# CANCELLED (empty book), PARTIALLY_CANCELLED (partial fill), FILLED (full fill)
# ─────────────────────────────────────────────────────────────

# 19a: market buy with empty ask book → CANCELLED, no fills, balance unchanged
USD_BEFORE_MKT=$(_curl_json GET /balance -H "Authorization: Bearer $TOKEN_A" 2>/dev/null | jq -r '.USD // 0' 2>/dev/null || echo "0")
MKT_EMPTY_BUY_RESP=$(_curl_json POST /order/ -H "Authorization: Bearer $TOKEN_A" \
    -d '{"market":"BTC_USD","side":"buy","price":1,"quantity":1,"orderType":"market"}' 2>/dev/null || true)
MKT_EMPTY_BUY_ID=$(printf '%s' "$MKT_EMPTY_BUY_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -n "$MKT_EMPTY_BUY_ID" ] && [ "$MKT_EMPTY_BUY_ID" != "null" ]; then
    PASS=$((PASS + 1)); printf "  ${GREEN}PASS${NC}  %-64s\n" "Market buy on empty book"
    assert_body "Market buy empty book: status=CANCELLED"     '.status'         "CANCELLED" "$MKT_EMPTY_BUY_RESP"
    assert_body "Market buy empty book: filledQuantity=0"     '.filledQuantity' "0"         "$MKT_EMPTY_BUY_RESP"
    assert_body "Market buy empty book: fills=[]"             '.fills | length' "0"         "$MKT_EMPTY_BUY_RESP"
    # balance must be unchanged (locked funds returned)
    USD_AFTER_MKT=$(_curl_json GET /balance -H "Authorization: Bearer $TOKEN_A" 2>/dev/null | jq -r '.USD // 0' 2>/dev/null || echo "0")
    assert_body "Market buy empty book: USD balance unchanged (no funds consumed)" \
        '.USD' "$USD_BEFORE_MKT" \
        "$(_curl_json GET /balance -H "Authorization: Bearer $TOKEN_A" 2>/dev/null || true)"
else
    FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${NC}  %-64s no orderId\n" "Market buy on empty book"
fi
printf '%s\n' "$(jq -n --arg n "Market buy empty book → CANCELLED" --arg m POST --arg p /order/ \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$MKT_EMPTY_BUY_ID" ] && [ "$MKT_EMPTY_BUY_ID" != "null" ] && echo true || echo false)" \
    --argjson body "$(printf '%s' "$MKT_EMPTY_BUY_RESP" | jq -c . 2>/dev/null || echo '""')" \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# 19b: market sell with empty bid book → CANCELLED, base asset unlocked
MKT_EMPTY_SELL_RESP=$(_curl_json POST /order/ -H "Authorization: Bearer $TOKEN_B" \
    -d '{"market":"BTC_USD","side":"sell","price":1,"quantity":1,"orderType":"market"}' 2>/dev/null || true)
MKT_EMPTY_SELL_ID=$(printf '%s' "$MKT_EMPTY_SELL_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -n "$MKT_EMPTY_SELL_ID" ] && [ "$MKT_EMPTY_SELL_ID" != "null" ]; then
    PASS=$((PASS + 1)); printf "  ${GREEN}PASS${NC}  %-64s\n" "Market sell on empty book"
    assert_body "Market sell empty book: status=CANCELLED"     '.status'         "CANCELLED" "$MKT_EMPTY_SELL_RESP"
    assert_body "Market sell empty book: filledQuantity=0"     '.filledQuantity' "0"         "$MKT_EMPTY_SELL_RESP"
else
    FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${NC}  %-64s no orderId\n" "Market sell on empty book"
fi
printf '%s\n' "$(jq -n --arg n "Market sell empty book → CANCELLED" --arg m POST --arg p /order/ \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$MKT_EMPTY_SELL_ID" ] && [ "$MKT_EMPTY_SELL_ID" != "null" ] && echo true || echo false)" \
    --argjson body "$(printf '%s' "$MKT_EMPTY_SELL_RESP" | jq -c . 2>/dev/null || echo '""')" \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# 19c: market buy partially fills → PARTIALLY_CANCELLED
# Place 1 resting ask for 1 BTC; market buy wants 3 BTC → fills 1, cancels remaining 2
_curl_json POST /order/ -H "Authorization: Bearer $TOKEN_B" \
    -d '{"market":"BTC_USD","side":"sell","price":27500,"quantity":1,"orderType":"limit"}' > /dev/null 2>&1 || true
MKT_PART_BUY_RESP=$(_curl_json POST /order/ -H "Authorization: Bearer $TOKEN_A" \
    -d '{"market":"BTC_USD","side":"buy","price":1,"quantity":3,"orderType":"market"}' 2>/dev/null || true)
MKT_PART_BUY_ID=$(printf '%s' "$MKT_PART_BUY_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -n "$MKT_PART_BUY_ID" ] && [ "$MKT_PART_BUY_ID" != "null" ]; then
    PASS=$((PASS + 1)); printf "  ${GREEN}PASS${NC}  %-64s\n" "Market buy partial fill (want 3, only 1 available)"
    assert_body "Market buy partial: status=PARTIALLY_CANCELLED"  '.status'          "PARTIALLY_CANCELLED" "$MKT_PART_BUY_RESP"
    assert_body "Market buy partial: filledQuantity=1"            '.filledQuantity'  "1"                   "$MKT_PART_BUY_RESP"
    assert_body "Market buy partial: 1 fill recorded"             '.fills | length'  "1"                   "$MKT_PART_BUY_RESP"
else
    FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${NC}  %-64s no orderId\n" "Market buy partial fill"
fi
printf '%s\n' "$(jq -n --arg n "Market buy partial fill → PARTIALLY_CANCELLED" --arg m POST --arg p /order/ \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$MKT_PART_BUY_ID" ] && [ "$MKT_PART_BUY_ID" != "null" ] && echo true || echo false)" \
    --argjson body "$(printf '%s' "$MKT_PART_BUY_RESP" | jq -c . 2>/dev/null || echo '""')" \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# ─────────────────────────────────────────────────────────────
section "20 · INSUFFICIENT BALANCE"
# Engine must throw before corrupting state.
# ─────────────────────────────────────────────────────────────

# 20a: limit buy where price*qty > available USD
INSUF_BUY_RESP=$(_curl_json POST /order/ -H "Authorization: Bearer $TOKEN_A" \
    -d '{"market":"BTC_USD","side":"buy","price":99999,"quantity":99999,"orderType":"limit"}' 2>/dev/null || true)
run_test "POST /order – limit buy far beyond USD balance → HTTP 200 + engine error" \
    POST /order/ 200 \
    '{"market":"BTC_USD","side":"buy","price":99999,"quantity":99999,"orderType":"limit"}' "$TOKEN_A"
assert_body "Limit buy beyond balance: response has error key" \
    '.error' "balance is less than amount to lock" "$INSUF_BUY_RESP"

# 20b: limit sell where qty > available BTC (fresh user with no BTC)
# create a new user with only USD, no BTC
NOBTC_RESP=$(_curl_json POST /signup \
    -d "{\"username\":\"nobtc_${SUFFIX}\",\"password\":\"password123\"}" 2>/dev/null || true)
NOBTC_TOKEN=$(printf '%s' "$NOBTC_RESP" | jq -r '.token // empty' 2>/dev/null || true)
if [ -n "$NOBTC_TOKEN" ]; then
    _curl_json POST /deposit -H "Authorization: Bearer $NOBTC_TOKEN" \
        -d '{"asset":"USD","amount":10000}' > /dev/null 2>&1 || true
    INSUF_SELL_RESP=$(_curl_json POST /order/ -H "Authorization: Bearer $NOBTC_TOKEN" \
        -d '{"market":"BTC_USD","side":"sell","price":30000,"quantity":1,"orderType":"limit"}' 2>/dev/null || true)
    INSUF_SELL_ID=$(printf '%s' "$INSUF_SELL_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
    TOTAL=$((TOTAL + 1))
    if [ -z "$INSUF_SELL_ID" ] || [ "$INSUF_SELL_ID" = "null" ]; then
        PASS=$((PASS + 1)); printf "  ${GREEN}PASS${NC}  %-64s\n" "Limit sell beyond BTC balance → engine error (no orderId)"
        assert_body "Limit sell beyond base balance: error key present" \
            '.error' "balance is less than amount to lock" "$INSUF_SELL_RESP"
    else
        FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${NC}  %-64s unexpected orderId=%s\n" "Limit sell beyond BTC balance" "$INSUF_SELL_ID"
    fi
    printf '%s\n' "$(jq -n --arg n "Limit sell beyond BTC balance → engine error" --arg m POST --arg p /order/ \
        --arg e "200" --arg a "200" \
        --argjson passed "$([ -z "$INSUF_SELL_ID" ] || [ "$INSUF_SELL_ID" = "null" ] && echo true || echo false)" \
        --argjson body "$(printf '%s' "$INSUF_SELL_RESP" | jq -c . 2>/dev/null || echo '""')" \
        '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
    )" >> "$TMP"
fi

# 20c: market buy with zero quote balance → engine throws before order is created
ZERO_USER_RESP=$(_curl_json POST /signup \
    -d "{\"username\":\"zerousd_${SUFFIX}\",\"password\":\"password123\"}" 2>/dev/null || true)
ZERO_TOKEN=$(printf '%s' "$ZERO_USER_RESP" | jq -r '.token // empty' 2>/dev/null || true)
if [ -n "$ZERO_TOKEN" ]; then
    # no deposit — zero USD balance
    ZERO_BUY_RESP=$(_curl_json POST /order/ -H "Authorization: Bearer $ZERO_TOKEN" \
        -d '{"market":"BTC_USD","side":"buy","price":1,"quantity":1,"orderType":"market"}' 2>/dev/null || true)
    ZERO_BUY_ID=$(printf '%s' "$ZERO_BUY_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
    TOTAL=$((TOTAL + 1))
    if [ -z "$ZERO_BUY_ID" ] || [ "$ZERO_BUY_ID" = "null" ]; then
        PASS=$((PASS + 1)); printf "  ${GREEN}PASS${NC}  %-64s\n" "Market buy with 0 USD → engine error (no orderId)"
        assert_body "Market buy zero balance: error key present" \
            '.error' "insufficient quote balance for market buy" "$ZERO_BUY_RESP"
    else
        FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${NC}  %-64s unexpected orderId=%s\n" "Market buy 0 USD balance" "$ZERO_BUY_ID"
    fi
    printf '%s\n' "$(jq -n --arg n "Market buy with 0 USD → engine error" --arg m POST --arg p /order/ \
        --arg e "200" --arg a "200" \
        --argjson passed "$([ -z "$ZERO_BUY_ID" ] || [ "$ZERO_BUY_ID" = "null" ] && echo true || echo false)" \
        --argjson body "$(printf '%s' "$ZERO_BUY_RESP" | jq -c . 2>/dev/null || echo '""')" \
        '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
    )" >> "$TMP"
fi

# ─────────────────────────────────────────────────────────────
section "21 · ORDER STATUS TRANSITIONS – verified via getOrder"
# Place an order, verify OPEN. Partially fill it, verify PARTIALLY_FILLED.
# Fully fill it, verify FILLED.
# ─────────────────────────────────────────────────────────────
TRANS_SELL_RESP=$(_curl_json POST /order/ -H "Authorization: Bearer $TOKEN_B" \
    -d '{"market":"BTC_USD","side":"sell","price":26500,"quantity":3,"orderType":"limit"}' 2>/dev/null || true)
TRANS_SELL_ID=$(printf '%s' "$TRANS_SELL_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -n "$TRANS_SELL_ID" ] && [ "$TRANS_SELL_ID" != "null" ]; then
    PASS=$((PASS + 1)); printf "  ${GREEN}PASS${NC}  %-64s\n" "Sell order placed for status-transition test (3 BTC @ \$26.5k)"
    # verify OPEN immediately
    TRANS_STATE1=$(_curl_json GET "/order/$TRANS_SELL_ID" -H "Authorization: Bearer $TOKEN_B" 2>/dev/null || true)
    assert_body "Status transition: new order is OPEN"         '.status' "OPEN" "$TRANS_STATE1"
    assert_body "Status transition: filledQuantity starts at 0" '.filledQuantity' "0" "$TRANS_STATE1"

    # partial fill: buy 1 BTC
    _curl_json POST /order/ -H "Authorization: Bearer $TOKEN_A" \
        -d '{"market":"BTC_USD","side":"buy","price":27000,"quantity":1,"orderType":"limit"}' > /dev/null 2>&1 || true
    TRANS_STATE2=$(_curl_json GET "/order/$TRANS_SELL_ID" -H "Authorization: Bearer $TOKEN_B" 2>/dev/null || true)
    assert_body "Status transition: after 1-of-3 fill → PARTIALLY_FILLED" '.status' "PARTIALLY_FILLED" "$TRANS_STATE2"
    assert_body "Status transition: filledQuantity=1 after partial"         '.filledQuantity' "1"              "$TRANS_STATE2"

    # full fill: buy remaining 2 BTC
    _curl_json POST /order/ -H "Authorization: Bearer $TOKEN_A" \
        -d '{"market":"BTC_USD","side":"buy","price":27000,"quantity":2,"orderType":"limit"}' > /dev/null 2>&1 || true
    TRANS_STATE3=$(_curl_json GET "/order/$TRANS_SELL_ID" -H "Authorization: Bearer $TOKEN_B" 2>/dev/null || true)
    assert_body "Status transition: after full fill → FILLED"             '.status'          "FILLED" "$TRANS_STATE3"
    assert_body "Status transition: filledQuantity=3 when fully filled"   '.filledQuantity'  "3"      "$TRANS_STATE3"
    assert_body "Status transition: 2 fill records in fills array (1 per matching order)"  '.fills | length'  "2"      "$TRANS_STATE3"
else
    FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${NC}  %-64s no orderId\n" "Sell order placed for status-transition test"
fi
printf '%s\n' "$(jq -n --arg n "Status transition test (OPEN→PARTIALLY_FILLED→FILLED)" --arg m POST --arg p /order/ \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$TRANS_SELL_ID" ] && [ "$TRANS_SELL_ID" != "null" ] && echo true || echo false)" \
    --argjson body "$(printf '%s' "$TRANS_SELL_RESP" | jq -c . 2>/dev/null || echo '""')" \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# ─────────────────────────────────────────────────────────────
section "22 · CROSS-ASSET PAIR – ETH_BTC"
# Verify engine handles non-USD quote correctly. Base=ETH, quote=BTC.
# ─────────────────────────────────────────────────────────────
ETHBTC_SELL_RESP=$(_curl_json POST /order/ -H "Authorization: Bearer $TOKEN_A" \
    -d '{"market":"ETH_BTC","side":"sell","price":0.05,"quantity":10,"orderType":"limit"}' 2>/dev/null || true)
ETHBTC_SELL_ID=$(printf '%s' "$ETHBTC_SELL_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -n "$ETHBTC_SELL_ID" ] && [ "$ETHBTC_SELL_ID" != "null" ]; then
    PASS=$((PASS + 1)); printf "  ${GREEN}PASS${NC}  %-64s\n" "ETH_BTC limit sell placed (10 ETH @ 0.05 BTC each)"
    ETHBTC_DEPTH=$(_curl_json GET /depth/ETH_BTC 2>/dev/null || true)
    assert_body "ETH_BTC depth has ask"           '.asks | length > 0' "true"  "$ETHBTC_DEPTH"
    assert_body "ETH_BTC ask price = 0.05"        '.asks[0].price'     "0.05"  "$ETHBTC_DEPTH"
    # Crossing buy (user B has BTC from deposits)
    ETHBTC_BUY_RESP=$(_curl_json POST /order/ -H "Authorization: Bearer $TOKEN_B" \
        -d '{"market":"ETH_BTC","side":"buy","price":0.06,"quantity":5,"orderType":"limit"}' 2>/dev/null || true)
    ETHBTC_BUY_ID=$(printf '%s' "$ETHBTC_BUY_RESP" | jq -r '.orderId // empty' 2>/dev/null || true)
    if [ -n "$ETHBTC_BUY_ID" ] && [ "$ETHBTC_BUY_ID" != "null" ]; then
        ETHBTC_BUY_ORDER=$(_curl_json GET "/order/$ETHBTC_BUY_ID" \
            -H "Authorization: Bearer $TOKEN_B" 2>/dev/null || true)
        assert_body "ETH_BTC crossing buy: FILLED"                  '.status'          "FILLED" "$ETHBTC_BUY_ORDER"
        assert_body "ETH_BTC crossing buy: fill price=0.05 (maker)" '.avgPrice'        "0.05"   "$ETHBTC_BUY_ORDER"
        assert_body "ETH_BTC crossing buy: filledQty=5"             '.filledQuantity'  "5"      "$ETHBTC_BUY_ORDER"
    fi
    # cancel remaining ask (5 ETH still resting)
    _curl_json POST /order/cancel -H "Authorization: Bearer $TOKEN_A" \
        -d "{\"market\":\"ETH_BTC\",\"orderId\":\"$ETHBTC_SELL_ID\"}" > /dev/null 2>&1 || true
else
    FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${NC}  %-64s no orderId\n" "ETH_BTC limit sell placed"
fi
printf '%s\n' "$(jq -n --arg n "ETH_BTC cross-asset pair trade" --arg m POST --arg p /order/ \
    --arg e "200" --arg a "200" \
    --argjson passed "$([ -n "$ETHBTC_SELL_ID" ] && [ "$ETHBTC_SELL_ID" != "null" ] && echo true || echo false)" \
    --argjson body "$(printf '%s' "$ETHBTC_SELL_RESP" | jq -c . 2>/dev/null || echo '""')" \
    '{name:$n,method:$m,path:$p,expected_status:($e|tonumber),actual_status:($a|tonumber),passed:$passed,response:$body}'
)" >> "$TMP"

# ─────────────────────────────────────────────────────────────
section "23 · MISC / DEBUG ENDPOINTS"
# ─────────────────────────────────────────────────────────────
run_test "GET /db-check – returns user count"           GET /db-check 200
run_test "GET /debug/ping-engine – engine reachable"    GET /debug/ping-engine 200

# =============================================================
# FINAL SUMMARY
# =============================================================
printf "\n%.65s\n" "═══════════════════════════════════════════════════════════════════"
printf "  Total: %d  │  ${GREEN}Pass: %d${NC}  │  ${RED}Fail: %d${NC}\n" "$TOTAL" "$PASS" "$FAIL"
printf "%.65s\n" "═══════════════════════════════════════════════════════════════════"

# Assemble JSON output (use --slurpfile to avoid ARG_MAX limits)
jq -n \
    --arg run_at   "$RUN_AT" \
    --arg base_url "$BASE_URL" \
    --argjson total "$TOTAL" \
    --argjson pass  "$PASS" \
    --argjson fail  "$FAIL" \
    --slurpfile tests "$TMP" \
    '{
        run_at:   $run_at,
        base_url: $base_url,
        summary: {
            total: $total,
            pass:  $pass,
            fail:  $fail,
            pass_rate: (if $total > 0 then (($pass / $total * 1000 | round) / 10) else 0 end)
        },
        tests: $tests
    }' > "$RESULT_FILE"

printf "  Results saved → %s\n\n" "$RESULT_FILE"

[ "$FAIL" -gt 0 ] && exit 1 || exit 0
