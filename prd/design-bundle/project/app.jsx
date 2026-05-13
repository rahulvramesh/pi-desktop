// Pi Desktop — main app shell
const { useState: useSt, useEffect: useEf } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "accent": "#c84a1f",
  "font": "Geist",
  "density": "regular",
  "sidebar": true,
  "rightPane": "diff",
  "agentState": "working"
}/*EDITMODE-END*/;

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [view, setView] = useSt("chat"); // welcome | chat | files | history | settings | terminal
  const [agentState, setAgentState] = useSt(t.agentState);
  const [rightPane, setRightPane] = useSt(t.rightPane);
  const [sidebarOn, setSidebarOn] = useSt(t.sidebar);
  const [paletteOpen, setPaletteOpen] = useSt(false);

  // Sync agent state from tweaks
  useEf(() => { setAgentState(t.agentState); }, [t.agentState]);
  useEf(() => { setRightPane(t.rightPane === "none" ? null : t.rightPane); }, [t.rightPane]);
  useEf(() => { setSidebarOn(t.sidebar); }, [t.sidebar]);

  // Apply theme tokens to documentElement
  useEf(() => {
    const root = document.documentElement;
    root.dataset.theme = t.theme;
    root.dataset.density = t.density;
    root.style.setProperty("--accent", t.accent);
    // Derive accent-2 & soft from accent
    root.style.setProperty("--accent-2", t.accent);
    root.style.setProperty("--accent-soft", t.accent + "1A");
    root.style.setProperty("--accent-edge", t.accent + "47");
    // Font
    if (t.font === "Inter")        root.style.setProperty("--sans", `"Inter", ui-sans-serif, system-ui, sans-serif`);
    else if (t.font === "JetBrains Mono") root.style.setProperty("--sans", `"JetBrains Mono", ui-monospace, monospace`);
    else if (t.font === "IBM Plex Sans") root.style.setProperty("--sans", `"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif`);
    else root.style.setProperty("--sans", `"Geist", ui-sans-serif, system-ui, sans-serif`);
  }, [t.theme, t.accent, t.font, t.density]);

  // ⌘K command palette
  useEf(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen(p => !p); }
      if (e.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Window body classes/widths
  const bodyClass = "window-body" +
    (sidebarOn ? "" : " no-sidebar") +
    (rightPane && view === "chat" ? " with-right" : "");
  const bodyStyle = {};

  return (
    <div className="app-shell">
      <div className="window">
        {/* Title bar */}
        <div className="titlebar">
          <div className="tl-left">
            <div className="tl-dot red"></div>
            <div className="tl-dot yellow"></div>
            <div className="tl-dot green"></div>
            <span style={{ width: 8 }}></span>
            <button className="icon-btn" title="Sidebar" onClick={() => setSidebarOn(!sidebarOn)}><Icon name="sidebar" size={14} /></button>
            <button className="icon-btn" title="History" onClick={() => setView("history")}><Icon name="history" size={14} /></button>
          </div>
          <div className="tl-center">
            <span className="pi-logo" style={{ width: 16, height: 16, fontSize: 12, borderRadius: 4 }}>π</span>
            <span className="crumb">Pi</span>
            <span className="tl-sep">/</span>
            <span className="crumb">openclaw</span>
            <span className="tl-sep">/</span>
            <span className="crumb-active">
              {view === "chat" ? "Level loader v2" :
               view === "welcome" ? "Welcome" :
               view === "files" ? "Files" :
               view === "history" ? "History" :
               view === "settings" ? "Settings" : view}
            </span>
            {agentState !== "idle" && view === "chat" && (
              <span className="pill accent" style={{ marginLeft: 10 }}>
                <span className="dot"></span>
                {agentState === "thinking" ? "thinking" : agentState === "working" ? "running" : "queued"}
              </span>
            )}
          </div>
          <div className="tl-right">
            <button className="icon-btn" title="Command palette  ⌘K" onClick={() => setPaletteOpen(true)}>
              <Icon name="command" size={14} />
            </button>
            <button className="icon-btn" title="Welcome"
              onClick={() => setView("welcome")}>
              <Icon name="sparkle" size={14} />
            </button>
            <button className="icon-btn" title="Settings" onClick={() => setView("settings")}>
              <Icon name="settings" size={14} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className={bodyClass} style={bodyStyle}>
          {sidebarOn && <Sidebar view={view} setView={setView} openCmd={() => setPaletteOpen(true)} />}

          {view === "welcome"  && <Welcome setView={setView} />}
          {view === "chat"     && <Chat
            agentState={agentState} setAgentState={setAgentState}
            rightPane={rightPane} setRightPane={setRightPane}
            sidebarOn={sidebarOn} setSidebarOn={setSidebarOn}
          />}
          {view === "files"    && <FilesView />}
          {view === "history"  && <History />}
          {view === "settings" && <Settings />}

          {view === "chat" && rightPane && <RightPane which={rightPane} setWhich={setRightPane} />}
        </div>

        {/* Status bar */}
        <div className="statusbar">
          <span className={"sb-item " + (agentState === "idle" ? "" : "accent")}>
            <span className="dot"></span>
            <span>{agentState === "idle" ? "ready" : agentState}</span>
          </span>
          <span className="sb-item">
            <Icon name="branch" size={11} /> feat/level-loader-v2
          </span>
          <span className="sb-item">
            <Icon name="git" size={11} /> 3 modified
          </span>
          <span className="sb-item">
            <Icon name="cpu" size={11} /> claude-sonnet-4.5 · 18.4k / 200k
          </span>
          <span className="spacer"></span>
          <span className="sb-item">interactive</span>
          <span className="sb-item">UTF-8 · LF</span>
          <span className="sb-item">v0.18.4</span>
        </div>

        {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} setView={setView} />}
      </div>

      <TweaksPanel>
        <TweakSection label="Theme" />
        <TweakRadio  label="Mode" value={t.theme} options={["light", "dark"]} onChange={v => setTweak("theme", v)} />
        <TweakColor  label="Accent" value={t.accent}
                     options={["#c84a1f", "#D97757", "#2A6FDB", "#1F8A5B", "#7A5AE0", "#0a0a0a"]}
                     onChange={v => setTweak("accent", v)} />
        <TweakSelect label="Font"   value={t.font}
                     options={["Geist", "Inter", "IBM Plex Sans", "JetBrains Mono"]}
                     onChange={v => setTweak("font", v)} />

        <TweakSection label="Layout" />
        <TweakToggle label="Sidebar"    value={t.sidebar} onChange={v => setTweak("sidebar", v)} />
        <TweakSelect label="Right pane" value={t.rightPane}
                     options={["none", "diff", "term", "preview"]}
                     onChange={v => setTweak("rightPane", v)} />
        <TweakRadio  label="Density"    value={t.density}
                     options={["compact", "regular", "comfy"]}
                     onChange={v => setTweak("density", v)} />

        <TweakSection label="Agent state" />
        <TweakRadio  label="Pi is" value={t.agentState}
                     options={["idle", "thinking", "working"]}
                     onChange={v => setTweak("agentState", v)} />

        <TweakSection label="Jump to" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 2 }}>
          {[
            ["welcome",  "Welcome"],
            ["chat",     "Chat"],
            ["files",    "Files"],
            ["history",  "History"],
            ["settings", "Settings"],
          ].map(([id, label]) => (
            <TweakButton key={id} onClick={() => setView(id)}>{label}</TweakButton>
          ))}
        </div>
      </TweaksPanel>
    </div>
  );
}

function CommandPalette({ onClose, setView }) {
  const items = [
    { name: "Switch to chat",     hint: "view",  go: () => setView("chat") },
    { name: "Open settings",      hint: "view",  go: () => setView("settings") },
    { name: "Open history",       hint: "/tree", go: () => setView("history") },
    { name: "Show file overview", hint: "view",  go: () => setView("files") },
    { name: "Show welcome",       hint: "view",  go: () => setView("welcome") },
    { name: "/share — upload session to gist", hint: "command" },
    { name: "/export — save session as HTML",  hint: "command" },
    { name: "/model — switch model",           hint: "⌃L" },
    { name: "/tree — navigate session tree",   hint: "/tree" },
    { name: "/reload — hot-reload extensions", hint: "/reload" },
    { name: "pi install npm:@earendil/pi-sandbox", hint: "install" },
  ];
  return (
    <div className="overlay" onClick={onClose}>
      <div className="palette" onClick={e => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" size={15} style={{ color: "var(--ink-3)" }} />
          <input placeholder="Type a command, file, or skill…" autoFocus />
          <span className="kbd">esc</span>
        </div>
        <div className="palette-list">
          {items.map((it, i) => (
            <div key={i} className={"palette-item" + (i === 0 ? " active" : "")} onClick={() => { it.go && it.go(); onClose(); }}>
              <Icon name={it.hint === "command" ? "command" : it.hint === "install" ? "package" : "arrowRight"} size={14} style={{ color: "var(--ink-3)" }} />
              <span className="name">{it.name}</span>
              <span className="hint">{it.hint}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
