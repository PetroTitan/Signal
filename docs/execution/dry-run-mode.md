# Dry-run mode

Phase E2 runs every action in dry-run. No external platform APIs are called. The engine evaluates authorization, marks the item, writes logs, creates an `execution_attempts` row, and tells the operator what *would* have happened.

## Why dry-run first

The engine ships with the safety state machine, contract authorization, retry policy, and audit trail wired end-to-end. What it doesn't ship is the external-publishing adapters. Those are deliberately out of scope until a separate phase adds the platform login + OAuth + posting code under another layer of approval gates.

## Dry-run action labels

`src/core/execution-engine/execution-types.ts` defines the synthetic action names:

```
would_publish_post
would_publish_comment
would_schedule_item
would_move_to_backlog
would_skip_risky_thread
would_send_engagement_signal
would_open_pr_for_review
```

The mapping from the weekly-contract action to its dry-run twin lives in `dryRunActionForAction(action)`. The dry-run label appears in the log message and in `execution_logs.metadata.dryRunAction`.

## Outcomes

`dryRunExecute(input)` returns one of:

- **executed** — authorization is `allow`. The item walks to `completed`. The log message reads "Dry-run: would publish post on reddit. No external call was made."
- **backlogged** — authorization is `soft_block` and the result hints `shouldBacklog`. The item moves to `backlogged`.
- **skipped** — authorization is `soft_block` and the result does not hint backlog. The item moves to `skipped`.
- **blocked** — authorization is `hard_block`. The item moves to `blocked`. Nothing executes.

## When real publishing arrives

The dry-run executor is pure and lives in `dry-run-executor.ts`. The real publishing layer should be a sibling module that takes the same `DryRunInput` shape (renamed) and produces a real outcome. The runner can then branch on a workspace flag (`workspace_settings.execution_mode = "dry_run" | "live"`) to pick the right executor.

Until then the UI and the API say "Dry-run only" on every surface that touches execution.

## See also

- [./execution-engine.md](./execution-engine.md)
- [./contract-authorization.md](./contract-authorization.md)
