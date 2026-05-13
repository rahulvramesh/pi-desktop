# Pi Desktop — handoff notes

Phases 1–3 of `prd/electron-pi-architecture-plan.html` §xiv. What was built, what's deferred, decisions taken, and a sketch for P4–P7.

## Design bundle provenance

The implementation handoff named the design bundle URL `https://api.anthropic.com/v1/design/h/dcS44xk5UoAtMuAacfWneQ?open_file=Pi+Desktop.html`. From the build environment that URL returns **HTTP 404** on both `WebFetch` and direct `curl` — verified twice, including a confirming retry after the implementation was complete. The endpoint is an Anthropic-internal authenticated preview host.

The same human operator then supplied a working replacement URL, `https://api.anthropic.com/v1/design/h/or6rOp7fZw6TJkVdO1nnuQ?open_file=Pi+Desktop.html`, which returned a 1.2 MB gzipped tarball containing the canonical `pi-dekstop` React/Babel prototype. That bundle is extracted into `prd/design-bundle/` and is what every renderer component is built against. The bundle's own `README.md` ("CODING AGENTS: READ THIS FIRST") and chat transcript confirm it is the intended handoff for this project. No content has been silently substituted — when ambiguous, the prototype and the architecture plan agree.

## Built

### P1 — Electron security baseline (§viii)

- `electron-vite` with three TS-strict bundles: main / preload / renderer. All TypeScript, no `any`, no `@ts-ignore`.
- `BrowserWindow`: `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, `webSecurity:true`.
- Strict CSP installed via `session.webRequest.onHeadersReceived` — `default-src 'self'`, `script-src 'self'`, no `unsafe-inline`, no `unsafe-eval`. Dev mode relaxes `connect-src` to `ws://localhost:*` and `style-src 'unsafe-inline'` for Vite HMR; production has no such relaxations.
- Preload exposes verbs only via `contextBridge` (`prompt`, `steer`, `followUp`, `abort`, `subscribe`, `getState`, `getMessages`, `setModel`, `setThinkingLevel`, `newSession`, `switchSession`, `fork`, `prefs.get/set`, `meta`). No `fs`, no `child_process`, no `path`.
- External links: `setWindowOpenHandler` denies `window.open`, routing http(s) to `shell.openExternal`. `will-navigate` is blocked to anything off the renderer origin.

### P2 — `AgentBackend` interface and `MockBackend`

- `src/agent/backend.ts` — type-only module mirroring §vi exactly. The renderer imports types from here; implementations stay in sibling files.
- `MockBackend` emits a scripted run for any prompt: opening text streamed as ~8-char `text_delta` chunks, then a `read` tool card on `src/levels/Loader.ts`, then an `edit` tool card on the same file with a +6/−1 diff, then a closing paragraph. `abort()` cancels the pending timer and resolves the in-flight promise. `dispose()` is idempotent.
- The renderer is 100% buildable against the mock. Tests cover the streamed conversation, idle-after-end, mid-run abort, dispose-then-prompt, and `newSession` clearing history.

### P3 — `LocalSdkBackend`

- Wraps `createAgentSession({ model: getModel('anthropic', 'claude-sonnet-4-6'), cwd, thinkingLevel })`.
- `ANTHROPIC_API_KEY` is read only via `process.env` — never persisted to electron-store, never logged, never URLed. Missing key is non-fatal: the backend constructs, the first prompt emits a structured error event. Any error message containing `sk-…` is redacted before crossing IPC.
- Normalizes SDK events (`message_update.assistantMessageEvent.text_delta`, `tool_execution_*`, etc.) into the flat `AgentEvent` union the renderer consumes. Tool arg/result previews are flattened to strings safe to drop into a `<pre>`.
- Factory in `src/agent/factory.ts` dispatches on `PI_BACKEND` env (`mock` | `sdk-local`, default `mock`). `rpc-local` / `rpc-ssh` throw explicitly so P6/P7 wiring is unmistakable.

### Renderer (per §x)

- React 18 + TS strict. CSS modules consume `tokens.css`. Dark mode and density spacing are pure-token swaps under `[data-theme]` / `[data-density]`.
- Title bar: decorative traffic lights (hidden on darwin where the OS renders real ones via `titleBarStyle: 'hiddenInset'`), π glyph, breadcrumb, animated status pill, action icons.
- Collapsible sidebar: Files tab driven by a hardcoded tree at `src/renderer/data/file-tree.ts`. Sessions / Skills / Packages render a "stubbed in P1–P3" empty state.
- Chat pane: user / assistant messages with avatars and timestamps, streaming assistant text rendered from text_delta events, tool-call cards (open the first by default, click to expand, mono preview), composer with Enter-to-send / Shift+Enter newline / Stop button while running.
- Right pane: Diff tab pulls the latest `edit` or `write` tool result from the message store and renders +/− lines using the diff tokens. Terminal and Preview tabs show a "stubbed in P1–P3" state.
- Status bar: agent state dot + label, branch, modified count, model + token usage, backend identifier (`mock` / `sdk-local`), version.
- Tweaks panel (floating bottom-right gear, ⌥T): theme, density, accent (6 swatches), sidebar toggle, right-pane picker, debug agent-state segmented control. Persisted to `app.getPath('userData')` via `electron-store@8`.

### Backpressure (§viii)

- `text_delta` events are coalesced per-message at ~16ms cadence in the main process before they cross IPC. A `message_end` flushes any pending delta first so the renderer never sees a close ahead of its last chunk.
- Preload expands the batched wire event back into an additive `text_delta` for renderer consumers — store code is agnostic to whether batching ran.

### Tests

- `npm test` — 9 Vitest unit tests across both backends (5 mock, 4 SDK with the SDK module mocked).
- `npm run test:e2e` — one Playwright smoke against the packaged Electron app + mock: sends a prompt, asserts the streamed reply text appears and the `Loader.ts` tool card renders, opens the tweaks panel, flips theme to dark, and asserts `document.documentElement.dataset.theme === 'dark'`.

## Deferred (per the brief's "out of scope")

- **P4** — custom tools bridging into Electron native dialogs (`defineTool`). Hooks in `LocalSdkBackend` (`createAgentSession`'s `customTools`) are unused but reachable.
- **P5** — code signing, `electron-builder` packaging, auto-update, crash reporting.
- **P6** — RPC subprocess backend (`pi --mode rpc` over stdio).
- **P7** — RPC over SSH.
- History / Welcome / Settings screens beyond the title-bar stubs.
- Command palette overlay (⌘K is a stub shortcut; the title bar icon opens nothing today).
- Multi-window.
- In-UI API-key entry.

## Decisions taken silently (per the brief's "decide silently" list)

- **Module layout.** Single repo, not a monorepo. `src/{main,preload,renderer,agent,shared}` with TS project references between the node-side (main + preload + agent + shared + tests/agent) and the web-side (renderer + shared + the type-only `agent/backend.ts`).
- **electron-store version.** Pinned `8.2.0` — the last CJS version. `electron-store@10+` is ESM-only and triggers Rollup-externalized-import grief on the Windows main process bundle. Functionally equivalent for our needs.
- **electron-vite version.** Pinned `^2.3.0`. v5 works but the current production-tested combo with Vite 5 + Electron 33 is v2.
- **Mock conversation arc.** Mirrors the design bundle's level-loader scenario verbatim (open `Loader.ts`, propose v2 chunk handling) so visual review against the prototype is one-to-one.
- **Tool argument extraction.** Normalized via path-of-least-surprise field detection (`path` / `file_path` / `command` / `pattern`). Future tools with unusual arg shapes will fall back to empty strings — annoying but not broken.
- **Renderer-owned chat history.** The renderer accumulates events into its store; the main process replays history only for the mock backend (where the script writes to its own buffer). LocalSdkBackend's `getMessages()` returns `[]` deliberately — pivoting to SDK-owned history requires mapping `AgentMessage` shapes and is P4-flavored work.
- **TS strict variants.** `noUncheckedIndexedAccess: true` everywhere. `exactOptionalPropertyTypes: false` — Pi SDK option objects use `field?: T` semantics that don't survive the strict version.
- **Preload format.** Forced to CJS via electron-vite output config. Sandboxed preload won't execute as ESM under Electron 33 + sandbox: true.

## P4–P7 estimates

| Phase | Scope                                                                       | Estimate          | Risk                                                                                          |
| ----- | --------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| P4    | Inline `defineTool()` bridges: native file picker, in-renderer diff approval, confirm dialog. Custom-tool wiring on LocalSdkBackend only. | 2–3 engineer-days | Tool result content shapes are diverse — needs careful type narrowing.                        |
| P5    | electron-builder pipeline, code signing (Apple Developer ID + Windows EV), notarization, auto-update channels, Sentry crashReporter. | 4–6 days, plus calendar time for cert procurement | Cert acquisition is the gating constraint, not engineering time. Schedule before P5 starts.   |
| P6    | RpcBackend against local `pi --mode rpc`. Manual buffer-split stdio reader (never `readline` — JSON contains U+2028/U+2029). Parity tests against LocalSdkBackend. | 3–4 days          | Strict stdio framing per §xv. Watch for `agent_end` settlement ordering vs subprocess exit.   |
| P7    | RPC-over-SSH transport, key prompts, host-key verification, reconnect on broken pipe, workspace switcher. CI container with `sshd` for e2e. | 4–6 days          | Cross-platform SSH config edge cases (Windows OpenSSH path handling, agent forwarding).       |

Total P4–P7: roughly 13–19 engineer-days excluding code-signing certificate procurement lead time.

## How to verify done

Per the brief's "DONE WHEN" checklist:

1. `npm install && npm run dev` → Electron window opens; sending a chat message streams a reply and two tool cards; tweaks panel toggles theme and density. ✓
2. `PI_BACKEND=sdk-local ANTHROPIC_API_KEY=… npm run dev` → same app, Claude Sonnet via the SDK. ✓ (needs a valid key; offline runs surface the error inline in the chat instead of crashing.)
3. `npm test` → Vitest: 9/9 passing. ✓
4. `npm run test:e2e` → Playwright smoke passes. ✓ (run `npm run build` first.)
5. `README.md` explains prereqs, run, backend switching, what's stubbed. ✓
6. No §viii security item violated. ✓
