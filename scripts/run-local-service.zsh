#!/bin/zsh

set -u

PROJECT_ROOT="/Users/avinoam/code/orchestrator-mcp"
NODE_BIN="/Users/avinoam/.nvm/versions/node/v24.14.0/bin/node"
NPM_BIN="/Users/avinoam/.nvm/versions/node/v24.14.0/bin/npm"
NPX_BIN="/Users/avinoam/.nvm/versions/node/v24.14.0/bin/npx"
TOKEN_TTL="8d"
TOKEN_REFRESH_SECONDS=604800

T3_SESSION_ID=""
MCP_CHILD_PID=""
REFRESH_CHILD_PID=""

revoke_t3_session() {
  if [[ -n "$T3_SESSION_ID" ]]; then
    "$NPX_BIN" -y t3@latest auth session revoke "$T3_SESSION_ID" >/dev/null 2>&1 || true
    T3_SESSION_ID=""
  fi
}

stop_children() {
  if [[ -n "$REFRESH_CHILD_PID" ]]; then
    /bin/kill "$REFRESH_CHILD_PID" 2>/dev/null || true
    wait "$REFRESH_CHILD_PID" 2>/dev/null || true
    REFRESH_CHILD_PID=""
  fi
  if [[ -n "$MCP_CHILD_PID" ]]; then
    /bin/kill -TERM "$MCP_CHILD_PID" 2>/dev/null || true
    wait "$MCP_CHILD_PID" 2>/dev/null || true
    MCP_CHILD_PID=""
  fi
}

cleanup() {
  stop_children
  revoke_t3_session
  unset T3_BEARER_TOKEN
}

handle_shutdown() {
  cleanup
  exit 0
}

trap handle_shutdown INT TERM HUP
trap cleanup EXIT

cd "$PROJECT_ROOT" || exit 1

while true; do
  SESSION_JSON=$(
    "$NPX_BIN" -y t3@latest auth session issue \
      --ttl "$TOKEN_TTL" \
      --label orchestrator-mcp-service \
      --subject orchestrator-mcp-service \
      --json
  )
  ISSUE_STATUS=$?
  if [[ $ISSUE_STATUS -ne 0 ]]; then
    print -u2 "Failed to issue a T3 session; retrying in 10 seconds."
    /bin/sleep 10
    continue
  fi

  T3_SESSION_ID=$(print -rn -- "$SESSION_JSON" | "$NODE_BIN" -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => process.stdout.write(JSON.parse(input).sessionId));
  ')
  T3_BEARER_TOKEN=$(print -rn -- "$SESSION_JSON" | "$NODE_BIN" -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => process.stdout.write(JSON.parse(input).token));
  ')
  unset SESSION_JSON
  export T3_BEARER_TOKEN

  "$NPM_BIN" run dev &
  MCP_CHILD_PID=$!

  (
    /bin/sleep "$TOKEN_REFRESH_SECONDS"
    /bin/kill -TERM "$MCP_CHILD_PID" 2>/dev/null || true
  ) &
  REFRESH_CHILD_PID=$!

  wait "$MCP_CHILD_PID" 2>/dev/null || true
  MCP_CHILD_PID=""

  if [[ -n "$REFRESH_CHILD_PID" ]]; then
    /bin/kill "$REFRESH_CHILD_PID" 2>/dev/null || true
    wait "$REFRESH_CHILD_PID" 2>/dev/null || true
    REFRESH_CHILD_PID=""
  fi

  revoke_t3_session
  unset T3_BEARER_TOKEN
  /bin/sleep 2
done
