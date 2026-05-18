# Runtime Proxy API Notes

This document tracks the current Electron IPC surface and the target Rust proxy HTTP/WebSocket surface.

## Current Electron IPC additions

### `runtime:statuses:get`

Returns warm/running runtime statuses for chats currently owned by Electron main.

Response:

```ts
interface ChatRuntimeStatus {
  chatId: string;
  projectId: string;
  runState: 'idle' | 'thinking' | 'running' | 'queued';
  active: boolean;
  hasRuntime: boolean;
  updatedAt: number;
}
```

Runtime behavior:

- Does not spawn a backend.
- Returns only runtimes that are warm/running in the current process.
- Cold chats are absent.

### `runtime:status`

Push event emitted whenever a warm runtime changes state or active visibility.

Payload: `ChatRuntimeStatus`.

Renderer behavior:

- Sidebar uses this for background running indicators.
- Delete/remove confirmation uses this to detect running runtimes.

### `agent:event:envelope`

Chat-scoped push event emitted for every warm runtime, active or background.

Payload after preload expansion:

```ts
interface AgentEventEnvelope {
  chatId: string;
  projectId: string;
  seq: number;
  timestamp: number;
  event: AgentEvent;
}
```

Wire payload may contain `text_delta_batch` / `thinking_delta_batch`; preload expands those to normal `AgentEvent` deltas before renderer callbacks run.

Renderer behavior:

- `useAgentStore` subscribes to all envelopes.
- Active chat state/messages update live.
- Background chat state/messages are cached by `chatId` so switching back can display already-streamed content immediately, then reconcile with backend `getMessages()`.

## Target Rust proxy API

Prefer chat-scoped APIs. Avoid server-global active chat. `src/renderer/client/http-pi-client.ts` already implements the renderer-side shape expected from this API. The Rust MVP lives in `runtime-proxy/`, is validated with `npm run proxy:check` / `npm run proxy:test`, persists projects/chats in SQLite, and can back Electron runtimes with `PI_BACKEND=proxy`.

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
POST /api/chats/:chatId/model
POST /api/chats/:chatId/thinking-level
POST /api/chats/:chatId/new-session
POST /api/chats/:chatId/switch-session
POST /api/chats/:chatId/fork

GET  /api/runtimes
GET  /api/meta
GET  /api/prefs
PATCH /api/prefs
GET  /api/dev/rpc-logs
DELETE /api/dev/rpc-logs
```

## Event streams

The proxy exposes both:

```txt
GET /api/events      WebSocket, for browser/web mode
GET /api/events/sse  Server-Sent Events, used by Electron main's ProxyBackend
```

## Target event envelope

```ts
interface RuntimeEventEnvelope<T> {
  chatId: string;
  seq: number;
  timestamp: number;
  event: T;
}
```

Event classes:

- Lossless: lifecycle, message boundaries, tool start/end, state changes.
- Coalescible: text/thinking deltas, tool progress, stats updates.

Slow-client behavior:

- Coalesce/drop deltas if a client queue fills.
- Preserve lifecycle events.
- Send `resync_required` when replay is not available.
