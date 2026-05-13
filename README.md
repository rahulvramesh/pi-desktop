# Pi Desktop

Electron-based desktop GUI for [Pi](https://pi.dev), a terminal coding agent. This repository covers **phases 1–3** of the architecture plan in `prd/electron-pi-architecture-plan.html` and the design bundle in `prd/design-bundle/`.

## Prerequisites

- **Node.js 20.19+** or **22.12+** (electron-vite requirement). Tested on Node 25.
- **Anthropic API key** for the real Claude Sonnet backend; not required for the default mock.

## Install and run

```bash
npm install
npm run dev          # default: PI_BACKEND=mock — no network required
```

The app opens a window that streams a scripted conversation when you send a prompt. Two tool-call cards (`read`, `edit`) render inline, the diff appears in the right pane, and the tweaks panel (bottom-right gear, or ⌥T) toggles theme, density, accent, sidebar, right pane, and a debug agent-state.

## Switching backends

Set `PI_BACKEND` before `npm run dev`:

| Value         | Behavior                                                                 |
| ------------- | ------------------------------------------------------------------------ |
| `mock` (default) | In-process scripted backend. No network. Used by tests and design review. |
| `sdk-local`   | Wraps `AgentSession` from `@earendil-works/pi-coding-agent`. Hardcoded to Claude Sonnet via the `anthropic` provider for P3. |
| `rpc-local`, `rpc-ssh` | Reserved for P6–P7. Throws today.                            |

### Running against Claude Sonnet

```bash
# macOS / Linux
export ANTHROPIC_API_KEY=sk-ant-...
PI_BACKEND=sdk-local npm run dev

# PowerShell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
$env:PI_BACKEND        = "sdk-local"
npm run dev
```

The key is read from the environment of the main process only — never written to disk, never logged, never serialized to session files. If the variable is missing, the app still launches; the first prompt emits an error event into the chat.

## Tests

```bash
npm test            # vitest — unit tests for MockBackend and LocalSdkBackend (mocked SDK)
npm run test:e2e    # playwright — smoke against the packaged Electron app + mock backend
npm run typecheck   # tsc --noEmit, both renderer and node tsconfigs
```

The Playwright smoke launches the production build, sends a message, asserts that the streamed reply and tool cards appear, and verifies the tweaks panel flips `data-theme`. Requires `npm run build` to have run at least once (the test script does not auto-build today).

## What's in this build

- **P1 — Electron security baseline.** `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`. Strict CSP via `session.webRequest`. Typed preload exposing verbs only — no `fs`, no `child_process`, no `path`. External links open via `shell.openExternal`; `window.open` is denied.
- **P2 — `AgentBackend` interface and `MockBackend`.** Interface lives at `src/agent/backend.ts` and matches §vi of the plan. The renderer is 100% buildable against the mock — `npm run dev` with no env vars works.
- **P3 — `LocalSdkBackend`.** Wraps the SDK's `AgentSession`. Single hardcoded model: Anthropic `claude-sonnet-4-6`. No model picker; no in-UI key entry.
- **Renderer.** React 18 + TS strict, Zustand for split UI/agent stores, CSS modules consuming the `--bg`/`--ink`/`--accent`/diff tokens from the design bundle, Radix Dialog for the tweaks panel, Lucide icons. No Tailwind, no CSS-in-JS runtime, no Redux, no Jest, no Next.
- **Backpressure.** `text_delta` events are coalesced in ~16ms windows by the main process before crossing IPC, then expanded back to additive deltas in the preload. This keeps the renderer thread responsive under sustained streams.

## What's stubbed

Out of scope for P1–P3, per the brief:

- RPC and SSH backends (phases 6–7).
- Code signing, auto-update, crash reporting (phase 5 / xii).
- Custom tools (`defineTool`) bridging into Electron native dialogs (phase 4).
- Multi-window, settings beyond tweaks, command palette overlay (⌘K is a no-op stub).
- History, Welcome, Settings screens. Sessions / Skills / Packages sidebar tabs render a "stubbed in P1–P3" empty state.
- Right-pane Terminal and Preview tabs (Diff is real, driven by the latest `edit`/`write` tool card).

## Repository layout

```
src/
  agent/                Backend interface, MockBackend, LocalSdkBackend, factory
  main/                 Electron main process: window, CSP, IPC bridges
  preload/              contextBridge — verbs only
  renderer/             React app. Sealed: never imports from main/ or preload/.
  shared/               Types shared across main/preload/renderer (no implementations)
tests/
  agent/                Vitest unit tests for both backends
  e2e/                  Playwright smoke (mock)
prd/
  electron-pi-architecture-plan.html
  design-bundle/        Original React/Babel prototype handed off from claude.ai/design
```

## Note on the design bundle

The brief shipped two design-bundle URLs. The first (`dcS44xk5UoAtMuAacfWneQ`) returned HTTP 404 from this environment; the second (`or6rOp7fZw6TJkVdO1nnuQ`) returned a gzipped tarball that has been extracted into `prd/design-bundle/`. Tokens, layout, component vocabulary, and the canonical chat screen are implemented against that bundle and §x of the architecture plan in parallel.

## Backend switching at a glance

```
PI_BACKEND env  →  src/agent/factory.ts  →  AgentBackend instance  →  Main IPC  →  Renderer
   mock               MockBackend             scripted events
   sdk-local          LocalSdkBackend         createAgentSession() from @earendil-works/pi-coding-agent
   rpc-local          (P6)
   rpc-ssh            (P7, requires PI_RPC_HOST)
```

## Troubleshooting

- **Black window on first launch.** Renderer hydrate hasn't completed; this should clear in <1s. If it persists, check the main process console for an IPC error.
- **`Cannot find module 'electron-store'`** when running the prod build. `npm install` was probably skipped; `electron-store@8` is required (v10+ is ESM-only and conflicts with the bundled CJS main on some Windows setups).
- **CSP violations in DevTools.** All scripts must be self-hosted; the strict CSP refuses inline scripts. Fonts.googleapis.com is allowed for the Geist/Instrument Serif fallback.
