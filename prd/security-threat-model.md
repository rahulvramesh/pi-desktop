# Security Threat Model

## Assets

- User source code and filesystem.
- Pi session files.
- API keys/OAuth credentials managed by Pi.
- RPC logs and tool outputs.
- Image attachments.
- SSH credentials/host trust.

## Trust boundaries

```txt
Renderer/browser UI
  -> Electron preload or HTTP API
  -> runtime service
  -> OS/filesystem/processes
  -> pi --mode rpc
```

The renderer/browser is not trusted with direct filesystem/process access.

## Local browser proxy requirements

- Bind to `127.0.0.1` by default.
- Generate random auth token at startup.
- Require token for every HTTP/WS request.
- Validate `Origin`.
- Do not use permissive CORS.
- Protect against DNS rebinding.
- Scope filesystem APIs to registered projects.
- Redact secrets and image base64 from logs.

## Electron requirements

- Keep `nodeIntegration:false`.
- Keep `contextIsolation:true`.
- Keep sandboxed preload.
- Expose verbs only through typed API/client.
- Do not expose `fs`, `path`, `child_process`, or arbitrary shell to renderer.

## Remote requirements

Remote control API must use one of:

- SSH tunnel.
- TLS/WSS with pairing token.
- Explicit authenticated remote daemon.

Never expose unauthenticated remote runtime control.

## Redaction rules

Always redact:

- `sk-*` API keys.
- Bearer tokens.
- `authorization`, `cookie`, `password`, `secret`, `credential` fields.
- Image `data` base64.
- Large raw payloads.

## Running/deleting safety

Deleting a running chat or project is destructive because it aborts a runtime. UI must confirm, and proxy API should require explicit force/abort semantics.
