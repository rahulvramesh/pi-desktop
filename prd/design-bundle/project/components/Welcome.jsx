// Welcome / onboarding screen
function Welcome({ setView }) {
  const cards = [
    { icon: "sparkle", t: "Start a session here", d: "Chat with Pi in this repo — files, git, build tools all available." },
    { icon: "folder",  t: "Open another folder",  d: "Point Pi at any directory on disk. AGENTS.md is auto-loaded." },
    { icon: "package", t: "Install a package",    d: "Sub-agents, plan mode, sandboxes — bring your own primitives." },
    { icon: "book",    t: "Read the docs",        d: "Hotkeys, extensions API, RPC + SDK. Five-minute tour." },
  ];
  return (
    <div className="chat">
      <div className="chat-header">
        <span className="pill"><Icon name="sparkle" size={10} /> Welcome</span>
        <span className="spacer"></span>
        <button className="btn ghost sm" onClick={() => setView("chat")}>
          Skip <Icon name="arrowRight" size={12} />
        </button>
      </div>
      <div className="welcome">
        <div className="welcome-card">
          <span className="pi-logo xl" style={{ marginBottom: 6 }}>π</span>
          <h1>There are many agent harnesses,<br/><em>but this one is yours.</em></h1>
          <div className="lede">
            Pi is a minimal coding harness. Adapt it to your workflows — not the other way around. Extensions,
            skills, prompts, and themes are just files in your repo.
          </div>

          <div className="cards-grid">
            {cards.map(c => (
              <div key={c.t} className="start-card" onClick={() => setView("chat")}>
                <span className="ico"><Icon name={c.icon} size={15} /></span>
                <div>
                  <div className="t">{c.t}</div>
                  <div className="d">{c.d}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="welcome-foot">
            <span>Last opened</span>
            <span className="mono" style={{ color: "var(--ink-2)" }}>~/projects/openclaw</span>
            <span>·</span>
            <span className="mono">feat/level-loader-v2</span>
            <span className="spacer"></span>
            <span className="kbd">⌘O</span> open  
          </div>

          <div style={{ marginTop: 26, display: "flex", gap: 18, fontSize: 11.5, color: "var(--ink-3)", alignItems: "center" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span className="pi-logo" style={{ width: 14, height: 14, fontSize: 10 }}>π</span> v0.18.4</span>
            <span>·</span>
            <span>15+ providers</span>
            <span>·</span>
            <span>MIT</span>
            <span>·</span>
            <a className="mono" style={{ color: "var(--accent)", textDecoration: "none" }}>pi.dev</a>
          </div>
        </div>
      </div>
    </div>
  );
}

window.Welcome = Welcome;
