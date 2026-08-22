# Delegation

Implementation on this project is delegated; the reviewing agent writes specifications
and verifies results. Prompts are committed under `tools/prompts/` so every delegated
step is repeatable rather than a message that scrolled away.

**Delegated work is a claim, not evidence.** Every task in this build has needed
corrections after its report said everything passed. Run the gates locally, look at the
screenshots, and measure the claims.

## Paths, measured 2026-08-22

| path | invocation | state |
| --- | --- | --- |
| `gpt-5.6-sol` | `codex exec -m gpt-5.6-sol --skip-git-repo-check "$(cat prompt)"` | **out of quota until 2026-08-29**. Best results of any path; used for P1 to P5.4 |
| Gemini 3.1 Pro | `opencode run -m antigravity/antigravity-gemini-3.1-pro "$(cat prompt)"` | **working**. Google OAuth, not OpenRouter |
| Claude Sonnet 4.6 (Antigravity) | as above | **broken** — streaming parse bug |
| Claude Opus 4.6 Thinking (Antigravity) | as above | **broken** — same bug, plus reasoning parts |
| `kimi-code/k3` | `kimi -m kimi-code/k3 -p "..." --output-format text` | **402, membership inactive** |
| OpenRouter | — | available but Andre asked for OAuth paths instead |

### The Antigravity streaming bug

Both Claude models through the Antigravity bridge fail with:

```
JSON parsing failed: ... Error message: JSON Parse error: Unable to parse JSON string
```

It only appears once a response spans **more than one chunk** — a one-word reply succeeds,
which makes it easy to mistake for a working path. Two concatenated JSON objects arrive
where one is expected, so the bridge is emitting newline-delimited JSON rather than the
framing opencode expects, and only the Claude model responses take that route. Gemini 3.1
Pro through the same bridge is fine.

`opencode.jsonc` already carries a comment recording that `gemini-3-pro` was retired for a
related envelope problem. This is the same family of fault.

**Verify a new path with a multi-chunk response**, not a single word. `"Count from 1 to
20, one per line"` is enough.

### A config bug fixed on the way

`opencode.jsonc` had its Onshape MCP server nested under an extra `mcp.servers` key, which
fails schema validation and disabled every MCP server plus `opencode run`. The entry now
sits directly under `mcp`. Backup at `~/.config/opencode/opencode.jsonc.bak-mcpfix`.

## Which model for which work

- **Physics, netcode, anything where a subtle error is expensive** — wait for Sol, or do it
  directly. These need the strongest available reasoning and they are where a plausible
  wrong answer costs the most.
- **Content against an automated standard** — Gemini is adequate, because
  `tools/level-audit.mjs` and `tools/level-export.mjs --lint` measure the result rather
  than trusting the report. Objective gates substitute for model judgement.
- **Anything visual** — regenerate the shots and look at them, whatever wrote it. Every
  visual defect this project has had was invisible in the written report and obvious in
  the first screenshot.
