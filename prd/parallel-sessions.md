# Parallel Sessions

## Required behavior

```txt
Chat A running
User opens Chat B
Chat A keeps running in background
Chat B gets or reuses its own runtime
User can switch between chats without aborting either one
```

## Current implementation notes

Electron main owns a `Map<chatId, ChatRuntime>`. With `PI_BACKEND=proxy`, each `ChatRuntime.backend` is an HTTP/SSE client for a Rust-proxy-owned `pi --mode rpc` child.

- `openChat(chatId)` reuses an existing runtime when present.
- `openChat(chatId)` creates a new backend only when absent.
- Opening a chat does not call global teardown.
- Inactive runtime `agent_end` persists the session file and touches chat recency.
- Runtime status IPC drives sidebar running indicators.
- `agent:event:envelope` streams chat-scoped events for active and background runtimes.
- Renderer caches background transcript/state by `chatId` and reconciles with backend state/messages on open.
- Idle inactive runtimes are pruned by TTL/max-warm policy.

## Remaining limitations

- Command IPC is still active-chat scoped in Electron mode (`prompt`, `abort`, model changes target the visible chat).
- Parallel agents in the same project still share a working tree, so file edit conflicts remain possible until worktree/exclusive-write policy lands.
- Event replay is in-memory/live only; a renderer reload must resync from backend state/messages.

## Manual verification

1. Open project.
2. Create Chat A.
3. Start a long prompt in Chat A.
4. Create/open Chat B while Chat A runs.
5. Confirm Chat A still shows running indicator in sidebar.
6. Start prompt in Chat B.
7. Switch between A and B.
8. Confirm each chat has independent state and neither is aborted by switching.

## Automated test

`tests/e2e/smoke.spec.ts` includes a Playwright mock-backend test that:

- Seeds project and two chats.
- Opens Chat A and prompts it.
- Switches/opens Chat B before Chat A finishes.
- Prompts Chat B.
- Asserts both chat rows show running at the same time.
- Switches back to Chat A and asserts transcript content exists.
