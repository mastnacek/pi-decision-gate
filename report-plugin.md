# Plugin Review: pi-decision-gate

Reviewed whole plugin. `npm run check` passes clean, git clean.

## Verdict: solid architecture, two real security holes

Good bones — modular TS, zero runtime deps, graceful degradation everywhere, clean type check. Two issues are security-relevant and should be fixed before trusting it in CI.

## Security issues (fix first)

### 1. Headless mode auto-approves destructive actions

In `gate.ts`:

```ts
if (!ctx.hasUI) {
  state.approvedCount += 1;
  return undefined;
}
```

This runs *after* `needsApproval === true`, so in non-interactive mode (`pi -p`, CI) a `rm -rf` / `git push --force` passes with no gate. Contradicts README claim "headless fallback... dle konfigurace".

Fix: headless should only auto-approve when category is `safe`; block destructive/risky.

### 2. Audit log persists secrets verbatim

`logDecision()` writes `input: event.input` raw to `.pi/decision-gate/decisions.jsonl`. The sensitive-data regex only guards the *Jev API call* — a tool call carrying a token/key still lands plaintext on disk. Directly violates NFR-3.

Fix: redact sensitive fields before `JSON.stringify` in `logDecision`.

## Correctness bugs

### 3. Recursion re-bills Jev + unbounded stack

"← Zpět", failed split, and change-thinking all `return handleToolCallGate(event, ctx, pi)`. Each loop re-calls `assessActionWithJev` (extra cost every cycle) and can recurse without bound on repeated back/change.

Fix: wrap dialog in a `while` loop, cache assessment once.

### 4. Blocked call missing `terminate: true`

SDK `ToolCallEventResult` supports `terminate` hint. Without it, agent may re-propose same destructive call within the batch.

### 5. Model-suitability regex broken

`evaluateModelSuitability`:

```ts
/\bclaude-3[.-]7|claude-3[.-]5-sonnet|o3|o1|r1|gemini-1\.5-pro|...|gpt-4o\b/
```

`o1` and `r1` are bare, unanchored alternatives — match substrings inside unrelated ids (e.g. `grok-r1`, anything with "o1"). `\b` anchors only the first/last branch.

Fix: wrap each alternative: `/(?:^|\b)(claude-3[.-]7|...|gpt-4o)(?:$|\b)/`.

## Functional gaps / minors

- **Catalog limited to 4 providers** (`fetch-models.mjs` hardcodes google/z-ai/moonshotai/deepseek). Model-switch dialog has no benchmark data for anthropic/openai/mistral → `findCatalogEntry` returns `undefined`, silently degrades to heuristic. Undercuts the "Jev model routing" feature.
- **Dead code:** `checkHerdrAvailability`, `closeHerdrPane` unused.
- **`refreshModelCatalog()`** spawns fetch on every `session_start` — network hit each launch, no TTL.
- **threshold range** inconsistent: command accepts `0.0–1.0`, help/README say `0.1–1.0`.
- `model_select` event verified real in SDK — handler is fine.

## What's genuinely good

- Offline regex heuristic + sanitization fallback = correct fail-open/safe design (NFR-1).
- Config cascade global→project, `--global` flag, lazy autocomplete follow repo `AGENTS.md` standard exactly.
- `event.input` in-place mutation matches SDK contract ("Mutate it in place to patch tool arguments").
- Faithful Eldritch ANSI palette, ČNB→ECB FX fallback, `.jsonl` audit shape — all clean.

Priority: fix #1 and #2, then #3.
