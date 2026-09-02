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

## Gemini 3.1 Pro also fails, and the output was not usable

Recorded after attempting Episode 4 on it, 2026-08-22.

**It hits the same streaming parse error.** The "count to 20" probe passed, so the fault is
not simply chunk count — it appears once tool calls and long reasoning payloads are in the
stream. Any probe short of a real task can pass and tell you nothing.

**It ignored the stated file scope**, editing `data.js` when told to write only `levels.js`
and `motifs.js`, and left a scratch file (`fix_ep4.js`) in the repository.

**The approach was wrong even where it worked.** Rather than editing `levels.js`, it wrote
a Node script to string-splice the file by searching for a comment and truncating from
there. That happens to have completed, which is the dangerous outcome: a half-run would
have silently truncated 39 working levels.

**The content itself failed every gate.** All 13 levels failed
`tools/level-export.mjs --lint`:

```
out-of-bounds · locked-material · did-not-settle · dead pigs
max movement 0.034 to 1.158 against a 0.02 requirement
codec round trip changed bytes · block y off the 0.25 grid
```

The designs were long runs of hand-placed identical cubes with no motif use, and comments
showing the model was unsure where a pig would seat.

Reverted with `git checkout -- levels.js`. One change was kept because it was correct:
`EPISODES[4].introduces` was missing `gel` while its own theme string listed it.

**The lesson is that the gate did its job.** Thirteen broken levels were caught in one
command, nothing reached a commit, and the recovery was a single checkout — because the
last commit was green and the standard is machine-checked. That is the whole argument for
committing only at green gates and for `tools/level-audit.mjs` existing.

## Subagents cannot wait for a long run — 2026-09-01

Recorded after three separate agents in one session each burned their whole context
reporting nothing.

A delegated agent launches its long commands in background shells that **die when its turn
ends**. So any task whose payoff is a 10-to-60-minute measurement comes back with "still
running, I'll wait for the notification" and no result, wakes up, reports the same thing,
and repeats. One reached 280k tokens saying it before being stopped with `TaskStop`.

**The split that works:** delegate the *writing* and the fast self-verification, then run
the long measurement yourself. That costs nothing once determinism is established, because
the numbers are identical whoever runs them — the `--siege` sweep hashed the same across
three separate runs, two machines states and a reboot.

Concretely, for this repo:

- Give the agent the harness change, the failure-injection proofs, and any check that
  finishes inside a minute or two.
- Take `--siege -n 2000`, `--comeback`, `playtest --all` and `determinism:all` yourself.
- If an agent's report says "still running", its background children are already dead.
  Check the tree for what it wrote, then run the measurement yourself. Do not resume it to
  wait — resuming restarts the same cycle.

## Two invocation traps that cost real time — 2026-09-01

**`codex exec resume` does not accept `-s`.** The subcommand takes sandbox mode as
`-c sandbox_mode="workspace-write"`. Passing `-s` makes it exit on argument parsing, which
in a `nohup ... &` launch looks exactly like a running job — the process is simply gone.
Sol sat idle for an interval before this was noticed. Always tail the log after launching a
backgrounded delegation, before reporting it as started.

**`pgrep -f <pattern>` matches its own shell.** A wait loop written as
`until ! pgrep -f "gpt-5.6-sol"; do sleep 15; done` never exits, because the shell running
it has that string in its own command line. Use a bracket to break the self-match
(`grep -c '[c]odex-linux-x64'`) or match on something the waiter does not contain. This was
hit three times in one session before being written down.

## Long-run output belongs on durable storage — 2026-09-01

Sweep output was written to the session scratchpad under `/tmp`. The machine rebooted
overnight, systemd cleared `/tmp`, and several hours of results went with it. The code was
never at risk — it was committed — but the measurements were, and they were the expensive
part.

Write anything that has to outlive the session to `~/.cache/slingwreck-balance/` or another
durable path. The scratchpad is documented as session-specific; long unattended runs are
precisely the case it does not cover.
