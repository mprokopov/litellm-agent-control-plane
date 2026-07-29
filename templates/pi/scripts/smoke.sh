#!/usr/bin/env bash
# End-to-end smoke test for the Pi Managed Agents server.
#
#   ./scripts/smoke.sh [base_url] [model] [runtime_api_key]
#
# Exercises health -> models -> agent create -> session -> prompt -> SSE stream
# and asserts the agent's reply actually comes back over the stream.
set -euo pipefail

BASE="${1:-http://localhost:8080}"
MODEL="${2:-gemini-2.5-flash}"
KEY="${3:-${RUNTIME_API_KEY:-}}"

auth=()
if [ -n "$KEY" ]; then auth=(-H "Authorization: Bearer $KEY"); fi

say() { printf '\n== %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

# Extract a top-level string field from a JSON document on stdin.
# Prefers python3; falls back to node, then jq. A regex would match the nested
# `model.id` instead of the agent id, so parse properly.
json_field() {
  local field="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import sys,json
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(0)
v=d.get('$field','')
print(v if v is not None else '')" 2>/dev/null
  elif command -v node >/dev/null 2>&1; then
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);process.stdout.write(String(o['$field']??''))}catch(e){}})" 2>/dev/null
  elif command -v jq >/dev/null 2>&1; then
    jq -r --arg f "$field" '.[$f] // empty' 2>/dev/null
  else
    echo "ERROR: need python3, node, or jq to parse JSON" >&2
    return 1
  fi
}

say "health"
curl -fsS "$BASE/health" || fail "health check failed"
echo

say "models"
curl -fsS "${auth[@]}" "$BASE/v1/models" | head -c 300 || fail "model discovery failed"
echo

say "create agent"
AGENT=$(curl -fsS "${auth[@]}" -X POST "$BASE/v1/agents" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"smoke\",\"model\":\"$MODEL\",\"system\":\"You are terse.\",\"tools\":[{\"type\":\"read\"}]}")
AGENT_ID=$(printf '%s' "$AGENT" | json_field id)
[ -n "$AGENT_ID" ] || fail "no agent id in: $AGENT"
echo "agent=$AGENT_ID"

say "create session"
SESSION=$(curl -fsS "${auth[@]}" -X POST "$BASE/v1/sessions" \
  -H 'Content-Type: application/json' -d "{\"agent\":\"$AGENT_ID\"}")
SESSION_ID=$(printf '%s' "$SESSION" | json_field id)
[ -n "$SESSION_ID" ] || fail "no session id in: $SESSION"
echo "session=$SESSION_ID"

say "attach stream"
STREAM_OUT=$(mktemp)
curl -sN --max-time 90 "${auth[@]}" "$BASE/v1/sessions/$SESSION_ID/events/stream" > "$STREAM_OUT" &
STREAM_PID=$!
sleep 2

say "prompt"
curl -fsS "${auth[@]}" -X POST "$BASE/v1/sessions/$SESSION_ID/events" \
  -H 'Content-Type: application/json' \
  -d '{"events":[{"type":"user.message","content":"Reply with exactly: PI-SMOKE-OK"}]}' \
  || fail "prompt rejected"
echo

say "await reply"
for _ in $(seq 1 40); do
  if grep -q "PI-SMOKE-OK" "$STREAM_OUT" 2>/dev/null; then break; fi
  sleep 2
done
kill "$STREAM_PID" 2>/dev/null || true

if grep -q "PI-SMOKE-OK" "$STREAM_OUT"; then
  echo "PASS: reply streamed"
else
  echo "--- stream contents ---"; cat "$STREAM_OUT"
  fail "expected reply not found on stream"
fi

say "history"
curl -fsS "${auth[@]}" "$BASE/v1/sessions/$SESSION_ID/events" | head -c 300
echo
rm -f "$STREAM_OUT"
echo "OK"
