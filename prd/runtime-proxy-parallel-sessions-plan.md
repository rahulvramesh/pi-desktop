# Pi Desktop Runtime Proxy + Parallel Sessions Plan

Status: draft architecture plan  
Last updated: 2026-05-17  
Scope: Electron runtime stabilization, Rust proxy feasibility, web mode, SSH/remote mode, performance, recoverability, scalability, and documentation requirements.

---

## 1. Executive Summary

Pi Desktop should evolve from an Electron-main-owned app into a renderer plus runtime service architecture.

Current direction:

```txt
React UI
  -> PiClient transport abstraction
  -> Runtime service
  -> per-chat Pi runtime
  -> pi --mode rpc
```

Runtime service implementations:

```txt
Short term: Electron main runtime manager
Medium term: local Rust pi-proxy
Long term: local/remote Rust pi-proxy with SSH/tunnel support
```

Primary goals:

1. Support true parallel sessions.
2. Enable browser/web mode without requiring Electron.
3. Make Electron a thin shell instead of the app backend.
4. Move OS-level responsibilities to a durable runtime service.
5. Improve recoverability across UI refreshes, process crashes, and remote disconnects.
6. Scale to many projects/chats without unbounded processes, memory, or event traffic.
7. Preserve Pi RPC semantics, including image inputs, token/cost stats, session files, tools, and JSONL framing.

---

## 2. Non-Negotiable Constraints

### 2.1 Preserve Pi RPC protocol correctness

Pi RPC mode uses strict LF-delimited JSONL.

Rules:

- Split only on `\n`.
- Strip optional trailing `\r`.
- Do not use generic line readers that split on Unicode line separators.
- Every command with an `id` must correlate with one response.
- Events are asynchronous and do not belong to the request/response lifecycle.

### 2.2 One chat/session must not break another

Opening or starting a new chat must not abort or dispose an existing running chat.

Correct behavior:

```txt
Chat A running
User opens Chat B
Chat A continues in background
Chat B opens/starts independently
User can switch back to Chat A
Chat A state and transcript remain valid
```

### 2.3 Runtime service must be chat-scoped, not globally active-chat-scoped

The backend API must move toward:

```txt
POST /api/chats/:chatId/prompt
GET  /api/chats/:chatId/state
GET  /api/chats/:chatId/messages
```

Avoid long-term APIs that depend on one server-global active chat:

```txt
POST /api/agent/prompt
```

A UI client may have a selected/visible chat, but runtime ownership is per chat.

### 2.4 Token, cost, and context stats are first-class state

Pi exposes stats through RPC:

```json
{ "type": "get_session_stats" }
```

The normalized UI state must include:

```ts
interface TokenUsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

interface AgentState {
  tokenUsage: TokenUsageSummary;
  costUsd: number;
  contextPercent: number | null;
  tokensUsed: number;
  tokensMax: number;
  autoCompactionEnabled: boolean;
}
```

Pi-style display target:

```txt
↑1.2M ↓33k R9.9M W12k $12.013 64.8%/272k (auto)
```

### 2.5 Image attachments are part of the transport contract

Pi RPC accepts image inputs:

```json
{
  "type": "prompt",
  "message": "What is in this image?",
  "images": [
    {
      "type": "image",
      "data": "base64-encoded-data",
      "mimeType": "image/png"
    }
  ]
}
```

Rules:

- UI may keep `name`/`size` metadata for thumbnails.
- Runtime/proxy must strip UI-only metadata before sending to Pi.
- Logs must never include image base64.
- Proxy must enforce count/size/MIME limits even if client already resized.

---

## 3. Current Electron Stabilization Plan

### 3.1 Replace singleton backend with per-chat runtimes

Previous model:

```ts
let backend: AgentBackend | null;
let activeChatId: string | null;
```

Required model:

```ts
interface ChatRuntime {
  chatId: string;
  projectId: string;
  backend: AgentBackend;
  unsubscribe: () => void;
  unsubscribeRpcLogs: (() => void) | null;
  pendingBatches: Map<string, PendingBatch>;
  pendingThinking: Map<string, PendingBatch>;
  eventSeq: number;
  idleSince: number;
  lastUsedAt: number;
}

const runtimes = new Map<string, ChatRuntime>();
let activeChatId: string | null;
```

Implemented direction in `src/main/agent-bridge.ts`:

- `openChat(chatId)` creates a runtime only if one does not exist.
- Switching chats changes `activeChatId` only.
- Existing runtimes are not disposed just because the user switches chats.
- Inactive runtime `agent_end` still persists session file and updates chat recency.

### 3.2 Event routing during interim Electron phase

Implemented Electron behavior:

```txt
Event from any warm chat runtime
  -> forwarded as agent:event:envelope with chatId/projectId/seq/timestamp

Event from active chat runtime
  -> also forwarded through legacy agent:event for compatibility
```

Envelope shape:

```json
{
  "chatId": "chat-123",
  "seq": 42,
  "timestamp": 1234567890,
  "event": { "type": "text_delta", "messageId": "a-...", "delta": "..." }
}
```

Renderer now maintains warm background chat state/transcript caches from chat-scoped events.

### 3.3 Per-runtime stream batching

Batch keys must be scoped by runtime/chat.

Do not use only:

```txt
messageId
```

Use conceptually:

```txt
chatId + messageId
```

In Electron runtime map, pending batches are stored inside each `ChatRuntime`.

### 3.4 Sidebar running-state tracking

Implemented:

```ts
Record<chatId, ChatRuntimeStatus>
```

Sidebar shows background activity:

```txt
Chat A  running...
Chat B  thinking...
Chat C  idle
```

This is driven by `runtime:status` / `runtime:statuses:get`.

### 3.5 Runtime cleanup policy

Parallel runtimes must not grow forever.

Implemented defaults:

```txt
maxWarmIdleRuntimes = 6
idleRuntimeTtlMs = 15 minutes
cleanupIntervalMs = 60 seconds
```

Policy:

- Never silently kill a running runtime.
- Idle inactive runtimes can be suspended/disposed after TTL.
- If limits are exceeded, prompt the user or suspend least-recent idle runtime.
- App quit should warn if runtimes are running.

### 3.6 Delete/remove safety

If a user deletes a chat or removes a project with active runtimes:

- Show confirmation.
- Offer abort/dispose.
- Persist latest session file before disposal when possible.
- Never orphan a UI row that still has a running process.

---

## 4. Rust Proxy Architecture

### 4.1 Proxy role

The Rust proxy should be a durable runtime manager, not only a thin HTTP wrapper.

It owns:

- Pi RPC subprocess lifecycle.
- Per-chat runtime map.
- JSONL framing and request correlation.
- Event sequencing and replay.
- Token/cost/context stats cache.
- Projects/chats DB.
- File tree/git/project icon APIs.
- Attachment validation.
- RPC trace redaction.
- Runtime limits and cleanup policy.
- Recovery states.
- Local/web/remote security boundary.

### 4.2 Suggested Rust stack

Recommended crates:

```txt
tokio
axum
tower-http
serde
serde_json
uuid
tracing
rusqlite or sqlx
notify
```

Optional later:

```txt
rfd       native folder picker
russh     native SSH implementation
git2      deeper git integration
```

### 4.3 Runtime unit

```rust
struct ChatRuntime {
    chat_id: ChatId,
    project_id: ProjectId,
    cwd: PathBuf,
    session_file: Option<PathBuf>,
    lifecycle_state: RuntimeLifecycleState,
    run_state: AgentRunState,
    child: PiRpcChild,
    pending_requests: HashMap<RequestId, PendingRequest>,
    event_seq: u64,
    event_buffer: RingBuffer<RuntimeEventEnvelope>,
    stats_cache: SessionStatsCache,
    last_error: Option<String>,
}
```

Lifecycle states:

```txt
cold        no process, metadata only
opening     process starting/restoring session
idle        process alive, no active run
running     agent processing
queued      has queued steer/follow-up
suspending  idle runtime being stopped
suspended   process stopped, resumable from session file
crashed     process exited unexpectedly
recovering  attempting restart/resume
disposing   intentional shutdown
```

---

## 5. API Design

### 5.1 Prefer chat-scoped APIs

Use:

```txt
POST /api/chats/:chatId/open
POST /api/chats/:chatId/prompt
POST /api/chats/:chatId/steer
POST /api/chats/:chatId/follow-up
POST /api/chats/:chatId/abort

GET  /api/chats/:chatId/state
GET  /api/chats/:chatId/messages
GET  /api/chats/:chatId/stats
GET  /api/chats/:chatId/models
```

Avoid server-global `activeChatId` in proxy APIs.

### 5.2 Project/chat APIs

```txt
GET    /api/projects
POST   /api/projects
PATCH  /api/projects/:projectId
DELETE /api/projects/:projectId

GET    /api/projects/:projectId/chats
POST   /api/projects/:projectId/chats
PATCH  /api/chats/:chatId
DELETE /api/chats/:chatId
```

### 5.3 File/git APIs

```txt
GET /api/fs/tree?projectId=...&depth=2
GET /api/fs/children?projectId=...&path=...
GET /api/git/status?projectId=...
GET /api/projects/:projectId/icon
```

### 5.4 Event stream API

One WebSocket initially:

```txt
WS /api/events
```

Event envelope:

```json
{
  "type": "agent_event",
  "chatId": "chat-123",
  "seq": 42,
  "timestamp": 1234567890,
  "event": {}
}
```

Later filtering options:

```txt
WS /api/chats/:chatId/events
WS /api/projects/:projectId/events
```

### 5.5 Idempotent command API

Mutating commands should accept `requestId`:

```json
{
  "requestId": "uuid",
  "message": "Fix the failing test",
  "images": []
}
```

If a client retries the same request:

```txt
same requestId -> do not send duplicate prompt
```

Request states:

```txt
accepted
queued
running
completed
failed_preflight
interrupted
```

---

## 6. Performance Requirements

### 6.1 Runtime process limits

A process per chat is safe and simple, but bounded limits are required.

Recommended defaults:

```txt
maxRunningRuntimes = 4
maxWarmIdleRuntimes = 6
maxTotalLoadedRuntimes = 12
idleSuspendAfterMs = 15 minutes
```

Never kill running sessions silently.

### 6.2 Backpressure and bounded queues

Architecture:

```txt
Pi stdout reader
  -> bounded per-runtime event queue
  -> event broadcaster
  -> bounded per-client WebSocket queue
```

Slow clients must not block Pi stdout reading.

Event classes:

```txt
lossless:
  agent_start
  agent_end
  message_start
  message_end
  tool_execution_start
  tool_execution_end
  state_changed

coalescible:
  text_delta
  thinking_delta
  tool_execution_update
  stats_update
```

If a client queue fills:

- Drop/coalesce deltas.
- Keep lifecycle events.
- Send a `resync_required` event.
- Client reloads state/messages.

### 6.3 Stats throttling

Do not spam `get_session_stats`.

Call:

- On chat open.
- On `turn_end`.
- On `agent_end`.
- While running, throttle to once every 1-2 seconds maximum.

### 6.4 File tree performance

Use lazy loading:

```txt
GET /api/fs/tree?depth=2
GET /api/fs/children?path=...
```

Rules:

- Skip heavy directories: `node_modules`, `.git`, `target`, `dist`, `out`, `build`, `.next`, `coverage`.
- Enforce max entries and max depth.
- Cache and invalidate with debounced watchers.

### 6.5 Git status performance

Rules:

- Debounce status checks by 1-2 seconds.
- Refresh after `agent_end`.
- Refresh after known edit/write tool results.
- Avoid continuous polling.

### 6.6 Image performance

Rules:

- Max image count: 6 by default.
- Max base64 payload: approximately 4.5 MB per image.
- Client-side resize first.
- Proxy validates again.
- Never log base64.
- Consider attachment IDs later to avoid repeated base64 transfer.

Future attachment API:

```txt
POST /api/attachments
  -> returns attachmentId

POST /api/chats/:chatId/prompt
  images: [{ attachmentId }]
```

---

## 7. Recoverability Requirements

### 7.1 Durable runtime DB

Proxy should persist runtime metadata:

```sql
runtime_sessions (
  chat_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_file TEXT,
  cwd TEXT NOT NULL,
  worktree_path TEXT,
  lifecycle_state TEXT,
  run_state TEXT,
  last_event_seq INTEGER,
  last_started_at INTEGER,
  last_seen_at INTEGER,
  last_error TEXT
);
```

Prompt/run journal:

```sql
runtime_runs (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  prompt_hash TEXT,
  status TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  error TEXT
);
```

### 7.2 Event sequence and replay

Every event from proxy gets:

```json
{
  "chatId": "chat-123",
  "seq": 42,
  "timestamp": 1234567890,
  "event": {}
}
```

Keep:

- In-memory ring buffer per chat.
- Optional persisted recent event log.

Reconnect flow:

```txt
client reconnects with lastSeenSeq
proxy replays missing events if available
otherwise sends resync_required
client reloads get_messages + get_state
```

### 7.3 Pi subprocess crash recovery

If `pi --mode rpc` exits unexpectedly:

```txt
runtime -> crashed
record stderr tail
emit runtime_crashed
preserve session_file
allow restart/resume
```

Recovery:

```txt
restart pi --mode rpc
switch_session(sessionFile)
load messages/state/stats
runtime -> idle/recovered
```

An in-flight prompt may not be recoverable. Mark it:

```txt
interrupted
```

### 7.4 Proxy crash recovery

On proxy restart:

- Load DB.
- Mark previously `running/opening` runtimes as `interrupted`.
- Do not assume child processes survived.
- Reopen chat by spawning fresh `pi --mode rpc` and `switch_session(sessionFile)`.

### 7.5 UI refresh and Electron window close

Browser reload must not kill runtimes.

Electron close behavior should be explicit:

- If sessions are running, ask before quitting.
- Options: keep running, abort all, cancel quit.
- Consider tray/background mode later.

### 7.6 Persist session file early

Do not wait only for `agent_end`.

Persist session file when:

- `get_state` returns `sessionFile`.
- `switch_session` succeeds.
- First prompt creates/returns a session file.
- `agent_end` fires.

---

## 8. Scalability Requirements

### 8.1 Multi-client model

Proxy must assume multiple clients:

- Electron window.
- Browser tab.
- Another browser tab.

Important rule:

```txt
Visible chat is client-local.
Runtime state is server-global per chat.
```

Do not use one global active chat on the server.

### 8.2 Long transcript scalability

Add pagination later:

```txt
GET /api/chats/:chatId/messages?before=entryId&limit=100
```

Renderer should eventually virtualize long transcripts.

### 8.3 RPC log scalability

RPC logs must be bounded:

```txt
ring buffer, default 800 entries
```

Only persist debug logs when dev mode is enabled.

Never persist:

- image base64
- API keys
- Authorization headers
- cookies
- huge raw tool outputs

---

## 9. Workspace Safety for Parallel Sessions

Parallel sessions in the same project can conflict on files.

### 9.1 Near-term policy

Allow parallel sessions, but warn:

```txt
Multiple agents are running in this project. File edits may conflict.
```

Track edit/write/bash activity by project.

### 9.2 Long-term worktree isolation

Preferred safe model:

```txt
one git worktree per chat runtime
```

Example:

```txt
<project>/.pi-desktop/worktrees/<chatId>/
```

Flow:

```txt
create worktree
run pi with cwd = worktree
agent edits isolated files
user reviews diff
merge/apply back to main project
```

Benefits:

- True parallel safe editing.
- Easy rollback.
- Cleaner per-chat diffs.
- Better remote support.

### 9.3 Non-git fallback

Options:

- Shared cwd with warning.
- Copy-on-write project snapshot.
- Exclusive write lock.

Config proposal:

```txt
projectWriteMode:
  shared      allow all
  warn        allow but warn
  exclusive   one writer per project
  worktree    isolate each chat
```

Recommended progression:

```txt
warn now
worktree later
```

---

## 10. Remote / SSH Plan

### 10.1 Short-term SSH transport

```txt
local proxy
  -> ssh host pi --mode rpc
```

Pros:

- Quick implementation.
- No remote daemon install.

Cons:

- Harder file tree/git status.
- Host key/auth prompts need UX.
- Reconnects are weaker.

### 10.2 Long-term remote proxy

```txt
UI
  -> local proxy
  -> SSH tunnel or WSS
  -> remote pi-proxy
  -> remote pi --mode rpc
```

Pros:

- Remote process management is local to remote host.
- Better recovery.
- Better file/git performance.
- Same API as local.

### 10.3 Remote connection states

```txt
connected
degraded
reconnecting
disconnected
failed_auth
host_key_changed
```

Reconnect flow:

```txt
reconnect
fetch runtime states
resume event stream by seq
resync state/messages if replay unavailable
```

---

## 11. Security Requirements

### 11.1 Local browser security

The proxy must not expose local filesystem/process APIs to arbitrary websites.

Rules:

- Bind to `127.0.0.1` by default.
- Generate random auth token at startup.
- Require token for every HTTP and WebSocket request.
- Validate `Origin`.
- No permissive CORS.
- Protect against DNS rebinding.
- Restrict filesystem access to registered project roots.
- Redact secrets and base64 images.

### 11.2 Remote security

Remote mode requires one of:

- SSH tunnel.
- TLS/WSS plus pairing token.
- Explicit authenticated remote daemon.

Never expose unauthenticated remote control APIs.

---

## 12. Observability Requirements

### 12.1 Metrics

Track:

```txt
runtime_count
running_runtime_count
idle_runtime_count
crashed_runtime_count
ws_client_count
events_per_second
ws_dropped_events
rpc_request_latency
pi_process_restart_count
memory_per_runtime
stdout_buffer_size
token_input/output/cache
cost
```

### 12.2 Structured logs

Every log should include relevant IDs:

```txt
chat_id
project_id
runtime_id
request_id
event_seq
```

Always redact:

- API keys.
- Bearer tokens.
- cookies.
- image base64.
- large RPC payloads.

### 12.3 Debug APIs

Dev mode only:

```txt
GET /api/debug/runtimes
GET /api/debug/events/:chatId
GET /api/debug/rpc-logs
```

---

## 13. Documentation Requirements and Instructions

Documentation is part of the implementation, not a follow-up task.

### 13.1 Required documentation files

Create and maintain these docs as the architecture evolves:

```txt
prd/runtime-proxy-parallel-sessions-plan.md       this plan
prd/runtime-proxy-api.md                          HTTP/WebSocket API spec
prd/runtime-lifecycle.md                          runtime state machine and transitions
prd/parallel-sessions.md                          current + target parallel session behavior
prd/recovery-runbook.md                           crash/restart/reconnect behavior
prd/security-threat-model.md                      local/web/remote security model
prd/documentation-checklist.md                    doc checklist for every PR/change
```

When Rust proxy work begins, add:

```txt
proxy/README.md                                   build/run/dev instructions
proxy/docs/jsonl-framing.md                       Pi RPC framing notes
proxy/docs/runtime-manager.md                     runtime internals
proxy/docs/events.md                              event envelopes/replay/backpressure
proxy/docs/config.md                              limits/security/settings
```

### 13.2 Required code comments

Any module that owns runtime behavior must document:

- What resource it owns.
- Who can dispose it.
- Whether it can outlive UI clients.
- Whether it is chat-scoped, project-scoped, or process-global.
- Recovery behavior on crash/disconnect.
- Backpressure behavior.

Examples:

```ts
/**
 * ChatRuntime owns one AgentBackend for one chat. Switching visible chats does
 * not dispose this runtime. Runtime disposal is explicit via cleanup policy,
 * chat deletion, project removal, or app shutdown.
 */
```

```rust
/// Reads strict LF-delimited JSONL from `pi --mode rpc`.
/// Do not replace with `lines()` if it treats Unicode separators as newlines.
```

### 13.3 Required API documentation

Every public API endpoint must document:

- Method/path.
- Auth requirements.
- Request schema.
- Response schema.
- Error schema.
- Idempotency behavior.
- Whether it mutates runtime state.
- Whether it starts/spawns a Pi process.
- Recoverability notes.

Example format:

```md
## POST /api/chats/:chatId/prompt

Starts or queues a prompt for one chat runtime.

### Request
...

### Response
...

### Errors
...

### Idempotency
`requestId` deduplicates retries.

### Runtime behavior
Starts runtime if cold. Does not affect other chats.
```

### 13.4 Required event documentation

Every event must document:

- Event name.
- Envelope fields.
- Ordering guarantee.
- Whether lossless or coalescible.
- Replay behavior.
- Resync behavior.

Event envelope must be documented once:

```ts
interface RuntimeEventEnvelope<T> {
  chatId: string;
  seq: number;
  timestamp: number;
  event: T;
}
```

### 13.5 Required state machine documentation

Every runtime lifecycle transition must be documented:

```txt
cold -> opening
opening -> idle
opening -> crashed
idle -> running
running -> idle
running -> crashed
idle -> suspending
suspending -> suspended
crashed -> recovering
recovering -> idle
recovering -> crashed
aany -> disposing
```

For each transition document:

- Trigger.
- Side effects.
- DB update.
- Events emitted.
- User-visible UI behavior.

### 13.6 Required recovery documentation

For every failure scenario document:

- Detection.
- User-visible message.
- Automatic recovery, if any.
- Manual recovery action.
- Data loss risk.
- How to test it.

Minimum scenarios:

```txt
Pi RPC process exits mid-run
Proxy crashes/restarts
Browser refreshes
Electron window closes
WebSocket disconnects
SSH disconnects
Session file missing
Session file corrupt
Project path missing
Model/auth failure
Image too large
Slow client backpressure
```

### 13.7 Required performance documentation

Every performance-sensitive subsystem must document:

- Limits.
- Defaults.
- Tuning knobs.
- Backpressure behavior.
- Cache invalidation.

Required topics:

```txt
runtime limits
idle runtime TTL
event batching
WebSocket queue limits
stats polling throttle
file tree depth/entry limits
git status debounce
image size/count limits
RPC log ring buffer size
```

### 13.8 Required security documentation

Security doc must include:

- Assets protected.
- Trust boundaries.
- Local browser threat model.
- Remote threat model.
- Token handling.
- Origin/CORS policy.
- Filesystem scope restrictions.
- Secret redaction rules.
- Image payload redaction rules.
- SSH host key handling.

### 13.9 Required testing documentation

Every feature PR must update docs with test instructions.

Minimum sections:

```md
## Manual verification
- Step 1
- Step 2

## Automated tests
- unit tests
- e2e tests

## Failure tests
- crash/reconnect/abort case
```

### 13.10 Documentation acceptance gate

A change is not complete unless:

- Public APIs are documented.
- Runtime lifecycle changes are documented.
- Recovery impact is documented.
- Performance limits are documented if affected.
- Security impact is documented if affected.
- Manual verification steps are documented.
- Tests are listed.

Use this checklist in every implementation task:

```txt
[ ] Code implemented
[ ] Unit tests added/updated
[ ] E2E/manual test added/updated
[ ] API docs updated
[ ] Lifecycle docs updated
[ ] Recovery docs updated
[ ] Performance notes updated
[ ] Security notes updated
[ ] README/HANDOFF updated if user-facing behavior changed
```

---

## 14. Implementation Phases

### Phase A — Electron parallel session correctness

Status: in progress.

Deliverables:

- Per-chat runtime map.
- No teardown on chat switch.
- Chat-scoped event envelope forwarding with legacy active stream compatibility.
- Background session file persistence.
- Background transcript/state cache in renderer.
- Per-runtime stream batching.
- Sidebar per-chat running indicators.
- Cleanup policy for idle runtimes.
- Delete/remove safety for running chats/projects.
- E2E test for switching chats while one runs.

### Phase B — PiClient abstraction

Deliverables:

- `PiClient` interface.
- `ElectronPiClient` using preload/window API.
- Renderer stores stop directly depending on `window.pi`.
- `HttpPiClient` scaffold for target Rust proxy HTTP/WebSocket API.
- Chat-scoped event subscription added to client interface.

### Phase C — Rust proxy MVP

Deliverables:

- `pi --mode rpc` child process manager.
- Strict JSONL reader/writer.
- Request correlation.
- Per-chat runtime map.
- HTTP API.
- WebSocket + SSE event streams.
- Electron `PI_BACKEND=proxy` bridge through `ProxyBackend`.
- Image prompt pass-through.
- Token/cost/context stats normalization.
- Redacted RPC logs.
- Proxy-mode E2E coverage with a mock JSONL Pi child.

### Phase D — Recoverability

Deliverables:

- Runtime DB.
- Request/run journal.
- Event seq/replay.
- Resync flow.
- Pi process crash recovery.
- Proxy restart recovery.
- Idempotent prompt requests.

### Phase E — Performance hardening

Deliverables:

- Runtime limits.
- Runtime TTL/suspend.
- Bounded queues.
- Stats throttling.
- File tree lazy loading.
- Git status debounce.
- Transcript pagination plan/implementation.

### Phase F — Move OS-level APIs to proxy

Deliverables:

- Projects/chats DB in proxy.
- File tree in proxy.
- Git status in proxy.
- Project icons in proxy.
- Preferences in proxy.
- Electron main becomes thin shell.

### Phase G — Web mode

Deliverables:

- Proxy serves React build.
- Browser works without Electron.
- Local auth token flow.
- Origin/CORS protections.
- Local folder/project workflow.

### Phase H — Remote mode

Deliverables:

- SSH subprocess transport.
- Remote connection state model.
- Reconnect/resync flow.
- Later remote proxy bootstrap/tunnel.

### Phase I — Workspace isolation

Deliverables:

- Warning for shared-cwd parallel writes.
- Optional exclusive write mode.
- Git worktree-per-chat mode.
- Diff/apply/merge UI.

---

## 15. Acceptance Criteria

### Parallel sessions

Done when:

- Start Chat A.
- While Chat A runs, open Chat B.
- Start Chat B.
- Chat A continues running.
- Chat B continues running.
- Switching between chats shows correct transcript/state.
- Sidebar shows both run states.
- Inactive chat completion persists session file.
- App shutdown disposes or preserves runtimes according to explicit policy.

### Performance

Done when:

- 4 running sessions stream without renderer lockup.
- Slow client cannot block Pi stdout reader.
- File tree on large repo does not freeze UI.
- Git status is debounced.
- Stats do not poll aggressively.
- Memory/process count is bounded.

### Recoverability

Done when:

- Browser refresh preserves running sessions.
- Electron close warns about running sessions.
- Pi crash surfaces in UI and can resume from session file.
- Proxy restart marks runs interrupted and can reopen chats.
- WebSocket reconnect replays or resyncs.
- Retried prompt request IDs do not duplicate prompts.

### Scalability

Done when:

- Multiple projects can have live runtimes.
- Multiple clients can observe same runtime.
- Long transcripts are paginated/virtualized.
- RPC logs remain bounded.
- Server has no global active chat dependency.

### Documentation

Done when:

- API spec exists and is current.
- Runtime lifecycle doc exists and is current.
- Recovery runbook exists and is current.
- Security threat model exists and is current.
- Performance limits are documented.
- README/HANDOFF reflect user-visible changes.
