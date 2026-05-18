# Runtime Lifecycle

A runtime is the process/session unit behind one chat.

## Current Electron runtime

```ts
interface ChatRuntime {
  chatId: string;
  projectId: string;
  backend: AgentBackend;
  pendingBatches: Map<string, PendingBatch>;
  pendingThinking: Map<string, PendingBatch>;
  runState: AgentRunState;
  eventSeq: number;
  idleSince: number;
  lastUsedAt: number;
}
```

Rules:

- One warm runtime per opened chat.
- Switching chats does not dispose previous runtimes.
- Commands route to the currently visible runtime in Electron mode.
- Runtime status events are emitted for background runtime state changes.
- Chat-scoped event envelopes are emitted for active and inactive runtimes.
- Renderer caches warm background transcript/state by `chatId`.

## Rust proxy MVP

`runtime-proxy/` contains an Axum/Tokio service that owns per-chat `pi --mode rpc` children and emits chat-scoped WebSocket/SSE event envelopes. Electron can now launch/use it with `PI_BACKEND=proxy`; Electron still owns project/chat metadata in that mode while the proxy owns agent child processes.

Validate with:

```bash
npm run proxy:check
```

## Target lifecycle states

```txt
cold        no process, only DB/session metadata
opening     process starting, restoring session
idle        process alive, no active run
running     agent is processing
queued      has queued steer/follow-up
suspending  idle runtime being stopped to save resources
suspended   process stopped, resumable from session file
crashed     process exited unexpectedly
recovering  attempting restart/resume
disposing   shutting down intentionally
```

## Disposal policy

Never silently dispose a running runtime.

Allowed disposal triggers:

- Explicit chat delete.
- Explicit project remove.
- App shutdown after user confirms or policy allows.
- Idle inactive runtime TTL.
- Runtime limit eviction of idle runtime.

## Immediate cleanup requirements

- Delete chat -> dispose its runtime first, then delete DB row.
- Remove project -> dispose all project runtimes first, then delete project row.
- Dispose must clear batch timers and unsubscribe listeners.

## Current TTL defaults

```txt
maxWarmIdleRuntimes = 6
idleRuntimeTtlMs = 15 minutes
cleanupIntervalMs = 60 seconds
```

Overrides:

- `PI_RUNTIME_IDLE_TTL_MS`
- `PI_RUNTIME_MAX_WARM_IDLE`

The cleanup pass only disposes idle inactive runtimes. It never silently kills a running runtime.
