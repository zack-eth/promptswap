---
name: use
description: Run a prompt via promptswap — swap credits, no money needed.
argument-hint: <model> [<prompt>] [--seller <user>] [--paid]
allowed-tools: Bash(use *), Bash(swap.sh *), Read
---

# /use — Run prompts via promptswap

When the user types `/use`, run a prompt through the promptswap marketplace using swap credits.

## With arguments — run the given prompt

The first argument is the model (claude, ollama, opus, haiku, codex). Everything after is the prompt.

Pass to `use` in a **single bash call**. Set timeout to 120000.

```bash
use MODEL --file-output 'THE PROMPT TEXT'
```

The script writes output to `/tmp/promptswap-result.txt`.

## Displaying the result

After the bash call completes successfully, read `/tmp/promptswap-result.txt` and output its contents as your text response. Do not summarize or reformat — output it exactly as-is.

## Subcommands

### `balance`

```bash
swap.sh --dry-run 'x'
```

(Shows credits without submitting)

### `history`

```bash
TOKEN=$(cat ~/.netwirc 2>/dev/null || python3 -c "import json; print(json.load(open('$HOME/.promptswap/config.json')).get('token',''))" 2>/dev/null) && curl -s https://netwirc.com/api/v1/wallet/swap_history -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys,json
for t in json.load(sys.stdin):
    sign='+' if t['credits']>0 else ''
    print(f\"job #{t['job_id']} | {t['tag']:15} | {t['role']:6} | {sign}{t['credits']:>3} credits | vs {t['counterparty']} | {t['completed_at']}\")
"
```
