# Privacy safe-synthesis gate for salience, anomalies, and belief-cockpit output

## Why this exists

Salience and anomaly data are designed to surface what matters without a search term. That makes them useful, but also dangerous: a page title, slug, tag, or cohort can accidentally reveal secrets, private addresses, passport identifiers, raw transcripts, or unnecessary health/admin detail.

Prompt wording is not a redaction layer. Any path that emits this material must pass through a deterministic gate first and fail closed if unsafe content remains.

## Current emission paths

As of this change, the current paths that can emit salience/anomaly/belief-cockpit material are:

1. Local CLI:
   - `src/commands/salience.ts` via `gbrain salience [--json]`
   - `src/commands/anomalies.ts` via `gbrain anomalies [--json]`
2. MCP/remote clients:
   - `src/core/operations.ts` operation `get_recent_salience`
   - `src/core/operations.ts` operation `find_anomalies`
   - HTTP MCP in `src/commands/serve-http.ts`, which exposes read-scoped operations to remote OAuth/legacy-token clients
   - stdio MCP in `src/mcp/server.ts` / `src/mcp/dispatch.ts`, which routes through the same operation handlers
3. Subagents / remote agent tools:
   - `src/core/minions/tools/brain-allowlist.ts` exposes `get_recent_salience` and `find_anomalies` to subagents. Those calls route through the shared operations handlers.
4. Telegram or report delivery:
   - No separate GBrain Telegram sender exists in this repo. Telegram-facing Hermes cron/report prompts can call the CLI or MCP operations above, so those outputs must already be redacted before the prompt layer sees them.
5. Belief-cockpit summaries:
   - The cockpit contract is currently stored as brain content rather than a dedicated `gbrain cockpit report` command. Any summary that includes salience or anomalies must consume only the gated operation/CLI output or call `sanitizeForSafeEmit()` before delivery.

## Implemented gate

`src/core/privacy-redaction.ts` provides:

- `sanitizeTextForSafeEmit()` for one string;
- `sanitizeForSafeEmit()` for recursive report objects;
- `safeSalienceResults()` for `SalienceResult[]`;
- `safeAnomalyResults()` for `AnomalyResult[]`;
- `assertSafeToEmit()` and `PrivacyRedactionError` for fail-closed verification.

The gate redacts these categories:

- secrets, API keys, bearer tokens, GitHub tokens, Slack tokens, AWS keys, JWTs, and labelled secret assignments;
- passport numbers and MRZ-shaped identity-document strings;
- US/UK street-address shaped private addresses;
- raw transcript terms and transcript/corpus paths;
- unnecessary health/admin detail such as diagnostic, medication, BP, passport-renewal, and tax-stress terms.

After replacement, the gate serializes the candidate output and checks again for forbidden patterns. If anything still matches, callers must refuse to emit.

## Freeze/manual-category-only rule

If the gate is disabled, throws `PrivacyRedactionError`, or a new emission path has not been wired through it yet, automated salience/anomaly/belief-cockpit delivery is frozen.

During the freeze, Mark-facing or remote outputs may only use manual category-level summaries, for example:

- "Health/admin showed activity and needs a next-action check."
- "Family/admin had unusual activity."
- "Revenue work is the highest-salience category."

Do not include raw page titles, slugs, tags, transcript summaries, addresses, passport identifiers, medication/diagnostic details, or secret-looking strings until the gate is fixed and tests pass.

## Test coverage

`test/privacy-redaction.test.ts` covers forbidden-pattern tests for:

- secrets;
- passport identifiers and MRZ;
- private addresses;
- raw transcript references;
- unnecessary health/admin detail;
- salience result fields;
- anomaly cohort/page-slug fields;
- fail-closed residual detection;
- generic report-object sanitization.
