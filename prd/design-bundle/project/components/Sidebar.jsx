// Sidebar — file tree, sessions, skills, packages
const { useState, useMemo } = React;

function TreeNode({ node, depth, selectedPath, onSelect, expanded, toggle }) {
  const isDir = node.type === "dir";
  const isOpen = expanded.has(node.path);
  const indent = 8 + depth * 12;
  if (isDir) {
    return (
      <>
        <div className="tree-row" style={{ "--indent": indent + "px" }} onClick={() => toggle(node.path)}>
          <Icon name="chevron" size={12} className={"tree-chev" + (isOpen ? " open" : "")} />
          <Icon name={isOpen ? "folderOpen" : "folder"} size={14} className="tree-icon" style={{ color: "var(--accent)" }} />
          <span>{node.name}</span>
        </div>
        {isOpen && node.children.map(c => (
          <TreeNode key={c.path} node={c} depth={depth+1} selectedPath={selectedPath} onSelect={onSelect} expanded={expanded} toggle={toggle} />
        ))}
      </>
    );
  }
  const ext = node.name.split(".").pop();
  const iconName = ext === "ts" || ext === "tsx" || ext === "js" ? "fileCode" : "file";
  const cls = "tree-row" +
    (selectedPath === node.path ? " selected" : "") +
    (node.status === "dirty" ? " dirty" : "") +
    (node.status === "added" ? " added" : "");
  return (
    <div className={cls} style={{ "--indent": indent + "px" }} onClick={() => onSelect(node.path)}>
      <span style={{ width: 12, flex: "0 0 12px" }}></span>
      <Icon name={iconName} size={14} className="tree-icon" />
      <span>{node.name}</span>
    </div>
  );
}

function Sidebar({ view, setView, openCmd }) {
  const D = window.PiData;
  const [tab, setTab] = useState("files");
  const [selected, setSelected] = useState("src/levels/Loader.ts");
  const [expanded, setExpanded] = useState(new Set([".pi", ".pi/skills", "src", "src/levels", "src/engine", "tests"]));
  const toggle = (p) => {
    const n = new Set(expanded);
    n.has(p) ? n.delete(p) : n.add(p);
    setExpanded(n);
  };

  return (
    <div className="sidebar">
      {/* Project switcher */}
      <div style={{ padding: "10px 12px 8px", display: "flex", alignItems: "center", gap: 9, borderBottom: "1px solid var(--border)" }}>
        <span className="pi-logo">π</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)", display: "flex", alignItems: "center", gap: 6 }}>
            {D.project.name}
            <Icon name="chevronD" size={12} style={{ color: "var(--ink-3)" }} />
          </div>
          <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)", display: "flex", alignItems: "center", gap: 4 }}>
            <Icon name="branch" size={10} />
            {D.project.branch}
          </div>
        </div>
        <button className="icon-btn" title="New session" onClick={() => setView("welcome")}>
          <Icon name="plus" size={15} />
        </button>
      </div>

      {/* Tabs */}
      <div className="sb-tabs">
        {[
          { id: "files",    icon: "fileCode", label: "Files" },
          { id: "sessions", icon: "history",  label: "Sessions" },
          { id: "skills",   icon: "skill",    label: "Skills" },
          { id: "packages", icon: "package",  label: "Packages" },
        ].map(t => (
          <div key={t.id} className={"sb-tab" + (tab === t.id ? " active" : "")} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={13} />
            <span>{t.label}</span>
          </div>
        ))}
      </div>

      {/* Search */}
      <div className="sb-search">
        <Icon name="search" size={13} style={{ color: "var(--ink-4)" }} />
        <input placeholder={tab === "files" ? "Find file…" : tab === "sessions" ? "Find session…" : "Search…"} />
        <span className="kbd">⌘K</span>
      </div>

      {/* Body */}
      <div className="sb-body">
        {tab === "files" && (
          <>
            <div className="sb-section">
              <span>Workspace</span>
              <button className="icon-btn" style={{ width: 20, height: 20 }} title="Refresh"><Icon name="refresh" size={11} /></button>
            </div>
            {D.files.map(n => (
              <TreeNode key={n.path} node={n} depth={0} selectedPath={selected} onSelect={setSelected} expanded={expanded} toggle={toggle} />
            ))}
            <div className="sb-section" style={{ marginTop: 14 }}><span>Changes — 3</span></div>
            <div className="tree-row added" style={{ "--indent": "8px" }}>
              <span style={{ width: 12 }}></span>
              <Icon name="fileCode" size={14} className="tree-icon" />
              <span>src/levels/schema.ts</span>
            </div>
            <div className="tree-row dirty" style={{ "--indent": "8px" }}>
              <span style={{ width: 12 }}></span>
              <Icon name="fileCode" size={14} className="tree-icon" />
              <span>src/levels/Loader.ts</span>
            </div>
            <div className="tree-row dirty" style={{ "--indent": "8px" }}>
              <span style={{ width: 12 }}></span>
              <Icon name="fileCode" size={14} className="tree-icon" />
              <span>tests/loader.test.ts</span>
            </div>
          </>
        )}

        {tab === "sessions" && (
          <div style={{ padding: "4px 4px 0", display: "flex", flexDirection: "column", gap: 4 }}>
            {D.sessions.map(s => (
              <div key={s.id} className={"session-item" + (s.active ? " active" : "")} onClick={() => setView("chat")}>
                <div className="sit-title" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {s.bookmark && <Icon name="bookmark" size={11} style={{ color: "var(--accent)", flex: "0 0 11px" }} />}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</span>
                </div>
                <div className="sit-meta">
                  <span>{s.time}</span>
                  <span>·</span>
                  <span className="mono" style={{ fontSize: 10.5 }}>{s.model}</span>
                  <span>·</span>
                  <span>{s.msgs} msgs</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "skills" && (
          <div style={{ padding: "8px 6px" }}>
            <div className="sb-section" style={{ padding: "4px 6px 8px" }}>Project skills · .pi/skills</div>
            {[
              { name: "level-format", desc: "WWD v1/v2 chunk layout", on: true },
              { name: "asset-rip",    desc: "Extract sprites from .rez", on: true },
              { name: "git-flow",     desc: "Commit, branch, PR helpers", on: false },
            ].map(s => (
              <div key={s.name} style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", marginBottom: 6, background: "var(--surface-2)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Icon name="skill" size={13} style={{ color: s.on ? "var(--accent)" : "var(--ink-3)" }} />
                  <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{s.name}</span>
                  <span className="spacer"></span>
                  <span className={"toggle" + (s.on ? " on" : "")} style={{ width: 26, height: 14 }}></span>
                </div>
                <div className="tiny muted" style={{ marginTop: 3 }}>{s.desc}</div>
              </div>
            ))}
            <div className="sb-section" style={{ padding: "12px 6px 8px" }}>User skills · ~/.pi/skills</div>
            <div style={{ padding: "8px 10px", borderRadius: 8, border: "1px dashed var(--border-strong)", color: "var(--ink-3)", fontSize: 12, textAlign: "center" }}>
              <Icon name="plus" size={12} />  add a skill
            </div>
          </div>
        )}

        {tab === "packages" && (
          <div style={{ padding: "8px 6px" }}>
            <div className="sb-section" style={{ padding: "4px 6px 8px" }}>Installed — 4</div>
            {[
              { name: "@earendil/pi-sandbox", v: "1.4.2", desc: "Bubblewrap exec sandbox", src: "npm" },
              { name: "@termdraw/pi",         v: "0.7.1", desc: "TUI drawing primitives", src: "npm" },
              { name: "badlogic/pi-doom",     v: "—",     desc: "yes really", src: "git" },
              { name: "openclaw-skills",      v: "0.2.0", desc: "Project skills bundle", src: "local" },
            ].map(p => (
              <div key={p.name} style={{ padding: "9px 10px", borderRadius: 8, border: "1px solid var(--border)", marginBottom: 6, background: "var(--surface-2)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Icon name="package" size={13} style={{ color: "var(--accent)" }} />
                  <span className="mono" style={{ fontSize: 11.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                </div>
                <div className="tiny muted" style={{ marginTop: 3 }}>{p.desc}</div>
                <div style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center" }}>
                  <span className="pill" style={{ fontSize: 10 }}>{p.src}</span>
                  <span className="mono tiny muted">{p.v}</span>
                </div>
              </div>
            ))}
            <button className="btn sm" style={{ width: "100%", justifyContent: "center", marginTop: 4 }}>
              <Icon name="plus" size={12} />  pi install …
            </button>
          </div>
        )}
      </div>

      {/* Account row */}
      <div className="account-row">
        <div className="avatar">{D.user.initials}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: "var(--ink)" }}>{D.user.name}</div>
          <div className="tiny muted">Pro · 1.4M tokens left</div>
        </div>
        <button className="icon-btn" title="Settings" onClick={() => setView("settings")}>
          <Icon name="settings" size={14} />
        </button>
      </div>
    </div>
  );
}

window.Sidebar = Sidebar;
