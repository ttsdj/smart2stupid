---
name: smart2stupid
description: Plan and audit a coding task in the current Codex chat, then delegate implementation to a persistent Claude Code CLI session shown in the smart2stupid VS Code execution panel. Use only when explicitly invoked as $smart2stupid.
---

# smart2stupid

Act as the requirement owner, planner, and reviewer. Claude Code is the only implementation agent.

## Invariants

- Do not edit product/source files. You may read them, inspect diffs, run verification, and write only inside `<workdir>/.smart2stupid/`.
- Do not write or synthesize files inside `~/.codex` or `~/.claude`. The official CLIs own their session formats.
- Do not guide Claude while a run is active. One interaction boundary is a complete handoff followed by a terminal result.
- Claude may choose ordinary technical details consistent with the brief. Return to the user for product behavior, scope, data risk, destructive actions, external publication, or acceptance changes.
- Confirm the final brief once before the first run. After confirmation, review/fix iterations are automatic up to three total runs.
- Redact secrets from user-facing artifacts. Never copy API keys, authorization headers, cookies, passwords, or tokens into review files.
- Do not start or open the legacy Web UI.
- Claude runs with automatic full tool permission through `bypassPermissions`. Recursive deletion and common bulk-delete command families are hard-denied by `stupid.disallowedTools`; never remove, weaken, bypass, or work around those rules. If a task genuinely requires bulk deletion, stop and report it as blocked.

## Plan in the current Codex chat

1. Inspect the workspace and existing instructions before asking questions.
2. Clarify decisions as a design tree. Ask every currently unblocked decision in one numbered round and include a recommended answer for each.
3. Produce a six-section Markdown brief: background, clarified decisions, polished implementation prompt, ordered plan, constraints, and acceptance criteria.
4. Show the complete brief in this Codex conversation and ask for one explicit confirmation.

## Delegate to Claude

Resolve the smart2stupid project root from `SMART2STUPID_ROOT`; if unset on this machine, use `D:/00.project/smart2stupid`. Verify that it contains `package.json` and `src/delegate.ts`.

Write the confirmed brief beneath `<workdir>/.smart2stupid/pending/`, then run from the smart2stupid project root:

Claude Code must create and resume its official session beneath the user's `.claude` directory. Run the following command outside the Codex filesystem sandbox, requesting/reusing a narrowly scoped approval for the `npm run delegate` prefix. This approval is only for the official Claude CLI session files; do not broaden it to unrelated commands.

```powershell
npm run delegate -- run --workdir "<absolute-workdir>" --brief-file "<absolute-brief-file>" --max-iterations 3
```

Wait for the command to finish. The VS Code extension observes `.smart2stupid/active.json` and shows the execution stream in the left structured panel. Capture `taskId`, `phase`, and `claudeSessionId` from the final `SMART2STUPID_RESULT=...` line.

For a later correction, keep the same task and session:

```powershell
npm run delegate -- run --workdir "<absolute-workdir>" --task-id "<task-id>" --feedback-file "<absolute-fix-file>"
```

Run correction commands with the same narrowly scoped outside-sandbox approval. Never fall back to an untracked direct `claude -p` call; every Claude turn must pass through the delegate event stream so it remains visible in the VS Code panel.

If the user selected “下轮新开会话” in the execution panel, the delegate command automatically creates a fresh Claude session for that next run.

## Review after each run

When the phase is `awaiting_review`:

1. Read `delegate-state.json`, the current `changes-<n>.json`, Claude's result, and the relevant changed files.
2. Inspect the task delta and Git diff. Do not attribute pre-existing dirty-worktree changes to Claude without baseline evidence.
3. Run focused verification when safe. Do not repair failures yourself.
4. Write a concise, evidence-based review under the task's `.smart2stupid` session directory.
5. Record it:

```powershell
npm run delegate -- review --workdir "<absolute-workdir>" --task-id "<task-id>" --verdict "pass|partial|fail" --review-file "<absolute-review-file>"
```

If the verdict is `pass`, report completion in the Codex chat. If it is `partial` or `fail`, write the smallest complete correction prompt and start the next run with `--feedback-file`.

Stop after three total runs. Report remaining failed or unknown criteria and wait for the user to click “追加一轮” or request a new Claude session.

## Blocked and failed runs

- `blocked`: answer ordinary technical questions from the brief and resume with a feedback file. Ask the user before resolving product, scope, risk, permissions, or acceptance decisions.
- `failed`: diagnose from the structured log. Retry only when the cause is transient and a retry is safe; otherwise report the failure.
- `cancelled`: do not restart automatically.
