# Execution state machine

Two state machines: one for queues, one for items. Both are explicit, with no implicit fallthroughs.

## Queue states

```
draft → ready → running → completed
              ↘ paused → ready
              ↘ failed → ready
draft → cancelled
ready → cancelled
running → cancelled
paused → cancelled
failed → cancelled
```

Terminal: `completed`, `cancelled`. (`failed` is recoverable — the operator can mark a recovered queue ready again.)

## Item states

```
pending_authorization → authorized
                      → blocked
                      → backlogged
                      → skipped
                      → cancelled

authorized → scheduled
           → ready
           → running
           → completed     (dry-run shortcut)
           → backlogged
           → skipped
           → blocked
           → paused
           → cancelled

scheduled → ready | running | paused | backlogged | cancelled
ready     → running | paused | backlogged | cancelled
running   → completed | failed | paused
paused    → ready | scheduled | backlogged | cancelled
failed    → ready | scheduled | cancelled | backlogged
```

Terminal: `completed`, `cancelled`, `skipped`, `blocked`, `backlogged`.

The `authorized → completed` shortcut exists because dry-run authorization and dry-run execution happen in one step. When real publishing arrives, that path should be removed and the runner should walk `authorized → running → completed`.

## Typed transitions

`transitionItem(from, to)` and `transitionQueue(from, to)` return a `TransitionVerdict`:

```ts
type TransitionVerdict<T> =
  | { ok: true;  from: T; to: T }
  | { ok: false; from: T; to: T; error: ExecutionStateError };
```

Repositories check the verdict before issuing the DB update. `ExecutionStateError` carries the from/to/kind so callers can decide whether to surface, log, or recover. No exceptions are thrown by the transition functions themselves; the repository may throw if the caller insists on running an invalid update.

## See also

- [./execution-engine.md](./execution-engine.md)
- [./queue-and-items.md](./queue-and-items.md)
