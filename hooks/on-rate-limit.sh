#!/bin/bash
# StopFailure hook — fires when Claude hits a rate limit.
# Saves the last user prompt so /continue can pick it up.

INPUT=$(cat)
mkdir -p ~/.promptswap

# Extract the user's prompt from the stop context
PROMPT=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    prompt = data.get('last_user_message', '') or data.get('prompt', '') or data.get('input', '')
    if not prompt:
        msgs = data.get('messages', [])
        for m in reversed(msgs):
            if m.get('role') == 'user':
                content = m.get('content', '')
                if isinstance(content, list):
                    content = ' '.join(c.get('text', '') for c in content if c.get('type') == 'text')
                prompt = content
                break
    print(prompt)
except:
    pass
" 2>/dev/null)

if [ -n "$PROMPT" ]; then
  echo "$PROMPT" > ~/.promptswap/last-prompt.txt
fi

exit 0
