#!/bin/bash
# Usage: swap.sh [prompt] [--paid] [--price <cents>] [--seller <username>]
# No args + TTY: interactive REPL (buy prompts + sell to earn credits)
# With args: one-shot prompt submission
set -e

TOKEN=$(cat ~/.netwirc 2>/dev/null)
if [ -z "$TOKEN" ]; then
  TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.promptswap/config.json')).get('token',''))" 2>/dev/null)
fi
if [ -z "$TOKEN" ]; then
  # Auto-register
  REAL_PATH="$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")"
  SCRIPT_DIR="$(cd "$(dirname "$REAL_PATH")" && pwd)"
  TOKEN=$(node --input-type=module -e "
    import { ensureToken } from '${SCRIPT_DIR}/../src/auth.js';
    const t = await ensureToken();
    process.stdout.write(t);
  " 2>/dev/null)
  if [ -z "$TOKEN" ]; then
    echo "Registration failed. Check your network connection." >&2
    exit 1
  fi
fi

TAG="prompt"
PRICE=5
SELLER=""
PAID=false
DRY_RUN=false
FILE_OUTPUT=false
PROMPT=""

# Parse args
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --price) PRICE="$2"; shift 2 ;;
    --seller) SELLER="$2"; shift 2 ;;
    --paid) PAID=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --file-output) FILE_OUTPUT=true; shift ;;
    *) if [ -z "$PROMPT" ]; then PROMPT="$1"; else PROMPT="$PROMPT $1"; fi; shift ;;
  esac
done

if [ -z "$PROMPT" ]; then
  echo "No prompt provided" >&2
  exit 1
fi

# Dry run — show cost without submitting
OUT="/tmp/promptswap-result.txt"
if [ "$DRY_RUN" = true ]; then
  TMP=$(mktemp)
  trap "rm -f $TMP" EXIT
  curl -s "https://netwirc.com/api/v1/marketplace/swap_cost?tag=$TAG" \
    -H "Authorization: Bearer $TOKEN" \
    -o "$TMP" 2>/dev/null
  python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
cost=d['swap_credit_cost']
credits=d['buyer_swap_credits']
can=d['can_swap']
after=d['credits_after']
status='OK' if can else 'INSUFFICIENT'
print(f'Tag: {d[\"tag\"]}')
print(f'Swap cost: {cost} credit{\"s\" if cost!=1 else \"\"}')
print(f'Your credits: {credits} → {after} after')
print(f'Status: {status}')
if not can:
    print(f'Need {cost} credits but only {credits - (-5)} available (floor: -5)')
" "$TMP"
  exit 0
fi

PROMPT_JSON=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$PROMPT")
TMP=$(mktemp)
trap "rm -f $TMP" EXIT

SELLER_FIELD=""
if [ -n "$SELLER" ]; then
  SELLER_FIELD="\"seller_username\": \"$SELLER\","
fi

# Try swap first unless --paid
JOB_ID=""
MODE=""
SWAP_COST=0
PRICE_CENTS=0

if [ "$PAID" = false ]; then
  curl -s -X POST https://netwirc.com/api/v1/marketplace/quick \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"tag\": \"$TAG\", \"description\": $PROMPT_JSON, $SELLER_FIELD \"swap\": true, \"auto_complete\": true}" \
    -o "$TMP" 2>/dev/null

  JOB_ID=$(python3 -c "import json; d=json.load(open('$TMP')); print(d.get('id',''))" 2>/dev/null)
  if [ -n "$JOB_ID" ]; then
    MODE="swap"
    SWAP_COST=$(python3 -c "import json; d=json.load(open('$TMP')); print(d.get('swap_credit_cost',1))" 2>/dev/null)
  fi
fi

# Fall back to paid
if [ -z "$JOB_ID" ]; then
  curl -s -X POST https://netwirc.com/api/v1/marketplace/quick \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"tag\": \"$TAG\", \"description\": $PROMPT_JSON, $SELLER_FIELD \"price_cents\": $PRICE, \"auto_complete\": true}" \
    -o "$TMP" 2>/dev/null

  JOB_ID=$(python3 -c "import json; d=json.load(open('$TMP')); print(d.get('id',''))" 2>/dev/null)
  if [ -z "$JOB_ID" ]; then
    python3 -c "import json; d=json.load(open('$TMP')); print(d.get('error','Unknown error'))" 2>/dev/null >&2
    exit 1
  fi
  MODE="paid"
  PRICE_CENTS=$(python3 -c "import json; d=json.load(open('$TMP')); print(d.get('price_cents',0))" 2>/dev/null)
fi

# Check for immediate result
BODY=$(python3 -c "import json; d=json.load(open('$TMP')); b=d.get('delivery_body') or ''; print(b) if b else exit(1)" 2>/dev/null) && GOT_RESULT=true || GOT_RESULT=false

# Poll if needed
if [ "$GOT_RESULT" = false ]; then
  for i in $(seq 1 30); do
    sleep 2
    curl -s "https://netwirc.com/api/v1/marketplace/jobs/$JOB_ID" \
      -H "Authorization: Bearer $TOKEN" \
      -o "$TMP" 2>/dev/null

    BODY=$(python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
b=d.get('delivery_body') or ''
s=d.get('status','')
if b: print(b); sys.exit(0)
if s in ('cancelled','expired'): print('Job '+s,file=sys.stderr); sys.exit(1)
if s == 'completed': print('Job completed with no output',file=sys.stderr); sys.exit(1)
sys.exit(2)
" "$TMP" 2>/dev/null)
    RC=$?
    if [ $RC -eq 0 ]; then GOT_RESULT=true; break; fi
    if [ $RC -eq 1 ]; then exit 1; fi
  done
fi

if [ "$GOT_RESULT" = false ]; then
  echo "Timed out waiting for result" >&2
  exit 1
fi

# Output
if [ "$FILE_OUTPUT" = true ]; then
  OUT=$(mktemp /tmp/promptswap-result.XXXXXX)
  if [ "$MODE" = "swap" ]; then
    echo "[via promptswap — swap, $SWAP_COST credit$([ "$SWAP_COST" != "1" ] && echo 's')]" > "$OUT"
  else
    USD=$(python3 -c "print(f'\${int($PRICE_CENTS)/100:.2f}')")
    echo "[via promptswap — paid, $USD]" > "$OUT"
  fi
  echo "" >> "$OUT"
  echo "$BODY" >> "$OUT"
else
  echo "$BODY"
fi
