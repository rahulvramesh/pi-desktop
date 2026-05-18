# Documentation Checklist

Use this checklist for every Pi Desktop runtime/proxy change.

## Required before marking a task done

- [ ] Code implemented.
- [ ] Unit tests added or updated.
- [ ] E2E/manual verification added or updated.
- [ ] API docs updated when an IPC/HTTP/WebSocket contract changes.
- [ ] Runtime lifecycle docs updated when process/session ownership changes.
- [ ] Recovery docs updated when crash/reconnect/shutdown behavior changes.
- [ ] Performance notes updated when limits, queues, caches, batching, polling, or runtime counts change.
- [ ] Security notes updated when filesystem/process/network/auth behavior changes.
- [ ] README/HANDOFF updated if user-facing behavior changed.

## Required doc locations

- `prd/runtime-proxy-parallel-sessions-plan.md` — source architecture plan.
- `prd/runtime-proxy-api.md` — IPC now, HTTP/WebSocket later.
- `prd/runtime-lifecycle.md` — runtime state machine and cleanup policy.
- `prd/parallel-sessions.md` — parallel-session behavior and tests.
- `prd/recovery-runbook.md` — crash/restart/reconnect playbook.
- `prd/security-threat-model.md` — local/web/remote threat model.

## API documentation template

```md
## METHOD /path-or-ipc-channel

Purpose.

### Request

### Response

### Errors

### Runtime behavior

### Idempotency

### Security notes

### Tests
```

## Runtime behavior template

```md
## Feature/runtime

Owner:
Scope: chat | project | process | client
Disposal:
Recovery:
Backpressure/performance:
Tests:
```
