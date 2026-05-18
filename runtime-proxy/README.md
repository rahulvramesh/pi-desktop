# Pi Runtime Proxy MVP

Rust HTTP/WebSocket runtime manager for Pi Desktop's future web/remote mode.

This is intentionally standalone while Electron still owns the production runtime path. It validates the proxy API shape, JSONL RPC child supervision, per-chat runtime ownership, event envelopes, and auth boundary.

## Run

From the repository root on Windows:

```bash
npm run proxy:run
```

Or directly with Cargo:

```bash
cargo run --manifest-path runtime-proxy/Cargo.toml
```

Environment:

```txt
PI_PROXY_HOST=127.0.0.1
PI_PROXY_PORT=3939
PI_PROXY_TOKEN=<optional; generated if omitted>
PI_PROXY_DB=<optional SQLite path; defaults to ./.pi-desktop-proxy.db>
PI_BIN=pi
PI_BIN_ARGS=<optional extra args inserted before --mode rpc>
```

The proxy binds locally by default, does not enable permissive CORS, and requires the token for all APIs except `/api/health`.

Electron can use it through the existing IPC bridge with:

```bash
npm run proxy:build
PI_BACKEND=proxy npm run dev
```

In proxy mode Electron still owns the project/chat SQLite UI shell, but each chat runtime is backed by the Rust proxy and its `pi --mode rpc` child.

Validation:

```bash
npm run proxy:fmt
npm run proxy:check
npm run proxy:test
npm run proxy:build
```

Auth:

```txt
Authorization: Bearer <token>
```

WebSocket clients may also use:

```txt
ws://127.0.0.1:3939/api/events?token=<token>
```

## Key endpoints

```txt
GET  /api/health
GET  /api/runtimes
GET  /api/events                  (WebSocket)
GET  /api/events/sse              (Server-Sent Events, used by Electron main)
POST /api/chats/:chatId/open
POST /api/chats/:chatId/prompt
POST /api/chats/:chatId/steer
POST /api/chats/:chatId/follow-up
POST /api/chats/:chatId/abort
GET  /api/chats/:chatId/state
GET  /api/chats/:chatId/messages
GET  /api/chats/:chatId/models
```

`open` accepts:

```json
{
  "projectId": "project-id",
  "cwd": "D:/path/to/project",
  "sessionFile": "optional pi session path",
  "title": "Chat title"
}
```

Events are broadcast as chat-scoped envelopes:

```json
{
  "chatId": "...",
  "projectId": "...",
  "seq": 1,
  "timestamp": 1710000000000,
  "event": { "type": "agent_start" }
}
```
