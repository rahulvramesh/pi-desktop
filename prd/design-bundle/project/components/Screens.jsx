// Settings, History, full-screen views

function Settings() {
  const sections = [
    { title: "Account", rows: [
      { lbl: "Signed in",  help: "Earendil account", ctrl: <><div className="avatar">MA</div><span style={{ fontSize: 13 }}>M. Adler · m@earendil.com</span><button className="btn sm ghost">Sign out</button></> },
      { lbl: "Plan",       help: "Pro · resets May 28", ctrl: <><span className="pill accent">Pro</span><button className="btn sm">Manage</button></> },
    ]},
    { title: "Providers & models", rows: [
      { lbl: "Default model",  help: "Used for new sessions",
        ctrl: <><div className="picker" style={{ display: "inline-flex", gap: 6, padding: "5px 10px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface)" }}>
          <Icon name="cpu" size={12} /><span className="mono small">claude-sonnet-4.5</span><Icon name="chevronD" size={11} />
        </div></> },
      { lbl: "Authenticated",  help: "API keys live in ~/.pi/auth/",
        ctrl: <div className="chips">
          {["anthropic", "openai", "google", "moonshot", "deepseek", "ollama"].map(p =>
            <span key={p} className="chip on"><span className="dot"></span>{p}</span>)}
          <span className="chip"><span className="dot"></span>azure</span>
          <span className="chip"><span className="dot"></span>bedrock</span>
          <button className="btn sm ghost"><Icon name="plus" size={11} /> add</button>
        </div> },
      { lbl: "models.json", help: "Custom providers & model aliases",
        ctrl: <><input className="input mono" defaultValue="~/.pi/models.json" /><button className="btn sm"><Icon name="edit" size={11} /> Open</button></> },
    ]},
    { title: "Context engineering", rows: [
      { lbl: "AGENTS.md cascade", help: "Loaded from ~/.pi → parents → cwd", ctrl: <><div className="toggle on"></div><span className="small">3 files loaded · 412 tokens</span></> },
      { lbl: "SYSTEM.md override", help: "Per-project system prompt", ctrl: <><div className="toggle"></div><span className="small muted">Using Pi defaults</span></> },
      { lbl: "Compaction", help: "Auto-summarize old turns near context limit",
        ctrl: <><div className="toggle on"></div><span className="small">at 80% · code-aware model</span></> },
      { lbl: "Skills", help: "Loaded on demand — progressive disclosure",
        ctrl: <div className="chips">
          {["level-format", "asset-rip"].map(s => <span key={s} className="chip on"><span className="dot"></span>{s}</span>)}
          <span className="chip"><span className="dot"></span>git-flow</span>
        </div> },
    ]},
    { title: "Permissions", rows: [
      { lbl: "Bash policy",       help: "Pi runs in this directory unless told otherwise",
        ctrl: <div className="chips">
          <span className="chip on"><span className="dot"></span>auto-allow reads</span>
          <span className="chip on"><span className="dot"></span>confirm writes outside repo</span>
          <span className="chip"><span className="dot"></span>sandbox via @earendil/pi-sandbox</span>
        </div> },
      { lbl: "Protected paths",   help: "Pi refuses to write here",
        ctrl: <input className="input mono" style={{ minWidth: 360 }} defaultValue=".env, ~/.ssh, ~/.aws" /> },
      { lbl: "Network access",    help: "Outbound HTTP from tool calls",
        ctrl: <><div className="toggle on"></div><span className="small">allowed · domain allow-list active</span></> },
    ]},
    { title: "Appearance", rows: [
      { lbl: "Theme", help: "Synced with system", ctrl: <div className="chips">
        <span className="chip on"><Icon name="sun" size={10}/>paper</span>
        <span className="chip"><Icon name="moon" size={10}/>ink</span>
        <span className="chip">auto</span>
      </div> },
      { lbl: "Font", help: "Used in chat and editor", ctrl: <><input className="input" defaultValue="Geist" /><span className="small muted">+ Geist Mono</span></> },
      { lbl: "Density",  help: "Padding and row height across the app", ctrl: <div className="chips"><span className="chip">compact</span><span className="chip on">regular</span><span className="chip">comfy</span></div> },
    ]},
    { title: "Keyboard", rows: [
      { lbl: "Send",     help: "Submit the composer",         ctrl: <span className="kbd">⏎</span> },
      { lbl: "Steer",    help: "Interrupt + steer running run", ctrl: <span className="kbd">⏎</span> },
      { lbl: "Queue",    help: "Send after current run",     ctrl: <span className="kbd">⌥⏎</span> },
      { lbl: "Stop",     help: "Cancel current tool",        ctrl: <span className="kbd">⌃C</span> },
      { lbl: "Model switch", help: "Cycle favorites",        ctrl: <><span className="kbd">⌃L</span><span className="kbd">⌃P</span></> },
      { lbl: "Command palette", help: "Run any /command",    ctrl: <span className="kbd">⌘K</span> },
      { lbl: "Tree navigate",   help: "Jump to past message", ctrl: <span className="kbd">/tree</span> },
    ]},
  ];

  return (
    <div className="chat">
      <div className="chat-header">
        <Icon name="settings" size={15} style={{ color: "var(--ink-2)" }} />
        <span style={{ fontWeight: 600, fontSize: 13.5 }}>Settings</span>
        <span className="spacer"></span>
        <button className="btn ghost sm"><Icon name="download" size={12} /> Export config</button>
      </div>
      <div className="settings">
        <h1>Settings</h1>
        <div className="lede">Everything Pi can do is also a file in <span className="mono" style={{ color: "var(--ink-2)" }}>~/.pi/</span>. Edit by hand or right here.</div>
        {sections.map(s => (
          <div key={s.title} className="set-group">
            <h3>{s.title}</h3>
            {s.rows.map((r, i) => (
              <div key={i} className="set-row">
                <div>
                  <div className="lbl">{r.lbl}</div>
                  <div className="help">{r.help}</div>
                </div>
                <div className="ctrl">{r.ctrl}</div>
              </div>
            ))}
          </div>
        ))}
        <div style={{ marginTop: 24, padding: "16px 20px", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 12, display: "flex", gap: 16, alignItems: "center" }}>
          <Icon name="info" size={18} style={{ color: "var(--accent)" }} />
          <div>
            <div style={{ fontWeight: 600 }}>Need something Pi doesn't do?</div>
            <div className="tiny muted" style={{ marginTop: 2 }}>Ask Pi to build it as an extension — or install one from a package.</div>
          </div>
          <span className="spacer"></span>
          <button className="btn sm"><Icon name="extension" size={12} /> Browse packages</button>
        </div>
      </div>
    </div>
  );
}

function History() {
  const D = window.PiData;
  return (
    <div className="chat">
      <div className="chat-header">
        <Icon name="history" size={15} style={{ color: "var(--ink-2)" }} />
        <span style={{ fontWeight: 600, fontSize: 13.5 }}>History</span>
        <span className="pill">{D.history.length} sessions</span>
        <span className="spacer"></span>
        <button className="btn ghost sm"><Icon name="download" size={12} /> Export</button>
      </div>
      <div className="history">
        <h1>Sessions</h1>
        <div className="lede">Every session is stored as a tree. Rewind, branch, share — or grep them all.</div>
        <div className="filter-bar">
          <div className="sb-search" style={{ margin: 0, minWidth: 320 }}>
            <Icon name="search" size={13} style={{ color: "var(--ink-4)" }} />
            <input placeholder="grep messages, file paths, tool outputs…" />
          </div>
          <div className="chips">
            <span className="chip on">all</span>
            <span className="chip"><Icon name="bookmark" size={9}/>bookmarked</span>
            <span className="chip">openclaw</span>
            <span className="chip">scratchpad</span>
          </div>
          <span className="spacer"></span>
          <span className="small muted">sort: recent</span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "22px 1fr 110px 110px 90px", gap: 14, padding: "0 14px 8px", fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: ".08em" }}>
          <span></span><span>Title</span><span>Model</span><span>Project</span><span style={{ textAlign: "right" }}>When</span>
        </div>
        {D.history.map(h => (
          <div key={h.id} className="history-row">
            <div>{h.bookmark ? <Icon name="bookmark" size={13} style={{ color: "var(--accent)" }} /> : <Icon name="layers" size={13} style={{ color: "var(--ink-4)" }} />}</div>
            <div>
              <div className="ttl">{h.title}</div>
              <div className="sub">{h.msgs} messages · tree depth 3 · 28k tokens</div>
            </div>
            <div className="mono tiny muted">{h.model}</div>
            <div className="mono tiny muted">{h.path}</div>
            <div className="time" style={{ textAlign: "right" }}>{h.time}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FilesView() {
  const D = window.PiData;
  return (
    <div className="chat">
      <div className="chat-header">
        <Icon name="folderOpen" size={15} style={{ color: "var(--accent)" }} />
        <span style={{ fontWeight: 600, fontSize: 13.5 }}>{D.project.path}</span>
        <span className="pill"><Icon name="branch" size={10} /> {D.project.branch}</span>
        <span className="pill warn"><Icon name="edit" size={10} /> 3 dirty</span>
      </div>
      <div className="chat-stream">
        <div className="chat-inner" style={{ maxWidth: 920 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div className="set-group" style={{ margin: 0 }}>
              <h3>Recently edited (by you)</h3>
              {["AGENTS.md", "package.json", ".pi/skills/level-format.md"].map(p => (
                <div key={p} className="set-row" style={{ padding: "10px 16px", gridTemplateColumns: "20px 1fr 80px" }}>
                  <Icon name="fileCode" size={14} style={{ color: "var(--ink-3)" }} />
                  <span className="mono small">{p}</span>
                  <span className="tiny muted" style={{ textAlign: "right" }}>2m ago</span>
                </div>
              ))}
            </div>
            <div className="set-group" style={{ margin: 0 }}>
              <h3>Recently edited (by Pi)</h3>
              {[
                { p: "src/levels/Loader.ts", a: 11, d: 2 },
                { p: "src/levels/schema.ts", a: 14, d: 0 },
                { p: "tests/loader.test.ts", a: 18, d: 0 },
              ].map(r => (
                <div key={r.p} className="set-row" style={{ padding: "10px 16px", gridTemplateColumns: "20px 1fr 90px" }}>
                  <Icon name="fileCode" size={14} style={{ color: "var(--accent)" }} />
                  <span className="mono small">{r.p}</span>
                  <span className="mono tiny" style={{ textAlign: "right" }}>
                    <span style={{ color: "var(--add)" }}>+{r.a}</span> <span style={{ color: "var(--del)" }}>−{r.d}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="set-group" style={{ marginTop: 16 }}>
            <h3>AGENTS.md</h3>
            <div style={{ padding: "12px 16px" }}>
              <pre className="code-block" style={{ background: "transparent", padding: 0, margin: 0, whiteSpace: "pre-wrap" }}>
{`# openclaw

Port of "Captain Claw" platformer to TypeScript + Bun + WebGPU.

## Conventions
- Prefer plain functions over classes; classes only where state lifecycle is real.
- Tile coordinates are integer; pixel coordinates are float.
- All level format work lives in src/levels/. Don't touch render/ without asking.
- Tests use bun:test, colocated under tests/.

## Hot paths
- src/engine/loop.ts — 60 Hz tick; budget 4ms.
- src/render/Atlas.ts — must batch; one draw call per material.

## What Pi can do
- read, edit, run, grep, glob, web — default tools.
- Skill: level-format — read this before touching .wwd parsing.
- Skill: asset-rip   — extract from packaged .rez archives.
- DO NOT commit. Leave commits for me.`}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

window.Settings = Settings;
window.History = History;
window.FilesView = FilesView;
