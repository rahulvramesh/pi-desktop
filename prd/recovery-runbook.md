# Recovery Runbook

## Pi RPC child exits mid-run

Detection:

- Child process exit/error.
- Pending requests rejected.

User-visible behavior:

- Runtime marked crashed/interrupted.
- Show stderr tail if safe/redacted.
- Offer restart/resume from session file.

Recovery:

1. Spawn fresh `pi --mode rpc`.
2. `switch_session(sessionFile)` if available.
3. Reload state/messages/stats.
4. Mark previous run interrupted.

Data loss risk:

- In-flight assistant/tool output after last persisted session entry may be lost.

## Proxy/Electron main restart

Detection:

- Process startup sees DB rows from prior runs.

Recovery:

- Treat previous warm/running runtimes as cold/interrupted.
- Spawn on next chat open.
- Resume from saved `sessionFile`.

## Browser refresh / WebSocket disconnect

Recovery:

1. Reconnect WS with last seen sequence.
2. Proxy replays missing events if available.
3. If replay unavailable, send `resync_required`.
4. Client reloads `state` + `messages` + `stats`.

## Chat delete/project remove while running

Current Electron behavior:

- Renderer asks for confirmation.
- Main disposes runtime before DB deletion.

Future proxy behavior:

- API should reject unless `force=true` or explicit abort policy is provided.

## Session file missing/corrupt

Recovery:

- Mark runtime recovery failed.
- Offer new session or manual session selection.
- Do not overwrite corrupt session automatically.

## Image too large

Recovery:

- Client attempts resize.
- Proxy validates and rejects if still above limit.
- UI keeps composer text and shows error.

## Slow client backpressure

Recovery:

- Drop/coalesce deltas.
- Preserve lifecycle events.
- Send `resync_required` if queue overflow invalidates continuity.
