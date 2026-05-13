// Chat — main conversation, tool call cards, composer
const { useState: useS, useRef, useEffect } = React;

const TOOL_ICON = {
  read: "read", edit: "edit", bash: "bash", grep: "grep", glob: "glob",
  write: "edit", web: "web", git: "git", skill: "skill",
};

function ToolCall({ t, idx }) {
  const [open, setOpen] = useS(idx === 0);
  const running = t.status === "run";
  return (
    <div className="toolcall">
      <div className="tc-head" onClick={() => setOpen(!open)}>
        <Icon name="chevron" size={12} className="tc-chev" style={{ color: "var(--ink-4)", transform: open ? "rotate(90deg)" : "none", transition: "transform .12s" }} />
        <Icon name={TOOL_ICON[t.name] || "wrench"} size={13} className="tc-icon" />
        <span className="tc-name">{t.name}</span>
        <span className="tc-arg">{t.arg}</span>
        {t.stats && (
          <span style={{ display: "inline-flex", gap: 6, marginLeft: 4 }}>
            <span style={{ color: "var(--add)" }}>+{t.stats.add}</span>
            <span style={{ color: "var(--del)" }}>−{t.stats.del}</span>
          </span>
        )}
        <span className={"tc-status " + (running ? "run" : "ok")}>
          {running ? <span className="thinking-bar"><span className="dots"><span></span><span></span><span></span></span></span> : <Icon name="check" size={12} />}
        </span>
        <span className="tc-time">{t.time}</span>
      </div>
      {open && t.preview && (
        <div className="tc-body">
          <pre className="code-block" style={{ margin: 0 }}>{t.preview}</pre>
        </div>
      )}
    </div>
  );
}

function MessageView({ m, isLast, agentState }) {
  const isUser = m.role === "user";
  const isAgent = m.role === "agent";
  const D = window.PiData;
  return (
    <div className={"msg " + (isUser ? "msg-user" : "msg-agent")}>
      <div className="msg-avatar">{isUser ? D.user.initials : "π"}</div>
      <div className="msg-body">
        <div className="msg-meta">
          <b>{isUser ? "You" : "Pi"}</b>
          <span>·</span>
          <span>{m.time}</span>
          {isAgent && isLast && agentState !== "idle" && (
            <>
              <span>·</span>
              <span className="thinking-bar">
                <Icon name="sparkle" size={11} style={{ color: "var(--accent)" }} />
                <span>{agentState === "thinking" ? "thinking" : agentState === "working" ? "working" : "queued"}</span>
                <span className="dots"><span></span><span></span><span></span></span>
              </span>
            </>
          )}
        </div>
        <div className="msg-text">{m.text}</div>
        {m.tools && m.tools.map((t, i) => <ToolCall key={i} t={t} idx={i} />)}
      </div>
    </div>
  );
}

function ModelPicker({ open, setOpen, current, onPick }) {
  const D = window.PiData;
  if (!open) return null;
  const byProv = {};
  D.models.forEach(m => { byProv[m.provider] = byProv[m.provider] || []; byProv[m.provider].push(m); });
  return (
    <div className="dropdown" style={{ left: 0 }}>
      <div className="tiny muted" style={{ padding: "4px 10px 6px" }}>Switch model · ⌃L</div>
      <div className="dd-sep"></div>
      {Object.entries(byProv).map(([prov, ms]) => (
        <div key={prov}>
          <div className="tiny muted mono" style={{ padding: "5px 10px 2px", textTransform: "uppercase", letterSpacing: ".08em", fontSize: 10 }}>{prov}</div>
          {ms.map(m => (
            <div key={m.id} className="dd-item" onClick={() => { onPick(m); setOpen(false); }}>
              <span>{m.label}</span>
              {m.id === current.id && <Icon name="check" size={13} className="check" />}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Composer({ agentState, setAgentState, model, setModel }) {
  const [mpOpen, setMpOpen] = useS(false);
  const [text, setText] = useS("");
  const running = agentState !== "idle";

  return (
    <div className="composer-wrap">
      <div className="composer">
        <div
          className="composer-text"
          contentEditable
          suppressContentEditableWarning
          data-placeholder={running ? "Steer the agent — Enter sends now, Alt+Enter queues a follow-up" : "Ask Pi to refactor, debug, run, explain…"}
          onInput={(e) => setText(e.currentTarget.textContent)}
        ></div>
        <div className="composer-foot">
          {/* model picker */}
          <div style={{ position: "relative" }}>
            <div className="picker" onClick={() => setMpOpen(!mpOpen)}>
              <Icon name="cpu" size={12} style={{ color: "var(--ink-3)" }} />
              <span className="mono" style={{ color: "var(--ink-2)", fontWeight: 500 }}>{model.label}</span>
              <Icon name="chevronD" size={11} style={{ color: "var(--ink-4)" }} />
            </div>
            <ModelPicker open={mpOpen} setOpen={setMpOpen} current={model} onPick={setModel} />
          </div>
          <div className="picker">
            <Icon name="extension" size={12} style={{ color: "var(--ink-3)" }} />
            <span className="mono" style={{ color: "var(--ink-3)" }}>3 skills · 4 extensions</span>
          </div>
          <span className="spacer"></span>
          <span className="tiny muted">
            <span className="kbd">⏎</span> {running ? "steer" : "send"} &nbsp;
            <span className="kbd">⌥⏎</span> queue &nbsp;
            <span className="kbd">⌃C</span> stop
          </span>
          {running ? (
            <button className="btn sm" onClick={() => setAgentState("idle")} title="Stop">
              <Icon name="stop" size={11} /> Stop
            </button>
          ) : (
            <button className="btn primary sm" onClick={() => { setAgentState("thinking"); setTimeout(() => setAgentState("working"), 800); }}>
              <Icon name="arrowUp" size={12} /> Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatHeader({ agentState, rightPane, setRightPane, sidebarOn, setSidebarOn }) {
  const D = window.PiData;
  return (
    <div className="chat-header">
      <button className="icon-btn" title="Toggle sidebar" onClick={() => setSidebarOn(!sidebarOn)}>
        <Icon name="sidebar" size={15} />
      </button>
      <div className="col" style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 13.5, color: "var(--ink)" }}>Level loader v2</span>
          <span className="pill"><Icon name="branch" size={10} /> feat/level-loader-v2</span>
          <span className="pill"><Icon name="layers" size={10} /> 24 msgs · 18.4k tokens</span>
        </div>
        <div className="tiny muted mono">{D.project.path}</div>
      </div>
      <div className="row">
        <button className="btn ghost sm" title="Rewind / branch this session">
          <Icon name="rewind" size={12} /> Tree
        </button>
        <button className="btn ghost sm" title="Share session">
          <Icon name="git" size={12} /> Share
        </button>
        <div style={{ width: 1, height: 18, background: "var(--border)" }}></div>
        <button className={"icon-btn" + (rightPane === "diff" ? " active" : "")} title="Diff" onClick={() => setRightPane(rightPane === "diff" ? null : "diff")}>
          <Icon name="git" size={15} />
        </button>
        <button className={"icon-btn" + (rightPane === "term" ? " active" : "")} title="Terminal" onClick={() => setRightPane(rightPane === "term" ? null : "term")}>
          <Icon name="terminal" size={15} />
        </button>
      </div>
    </div>
  );
}

function Chat({ agentState, setAgentState, rightPane, setRightPane, sidebarOn, setSidebarOn }) {
  const D = window.PiData;
  const [model, setModel] = useS(D.models.find(m => m.active));
  const lastIdx = D.messages.length - 1;
  return (
    <div className="chat">
      <ChatHeader agentState={agentState} rightPane={rightPane} setRightPane={setRightPane} sidebarOn={sidebarOn} setSidebarOn={setSidebarOn} />
      <div className="chat-stream">
        <div className="chat-inner">
          {/* Run-start system breadcrumb */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--ink-3)", fontSize: 11.5 }}>
            <div style={{ flex: 1, height: 1, background: "var(--border)" }}></div>
            <span className="mono"><Icon name="info" size={11} /> session started · loaded AGENTS.md (412 tokens) · 3 skills · interactive mode</span>
            <div style={{ flex: 1, height: 1, background: "var(--border)" }}></div>
          </div>
          {D.messages.map((m, i) => <MessageView key={m.id} m={m} isLast={i === lastIdx} agentState={agentState} />)}
          {agentState !== "idle" && (
            <div className="msg msg-agent">
              <div className="msg-avatar">π</div>
              <div className="msg-body">
                <div className="msg-meta">
                  <b>Pi</b><span>·</span><span>now</span><span>·</span>
                  <span className="thinking-bar">
                    <Icon name="sparkle" size={11} />
                    <span>{agentState === "thinking" ? "thinking" : "running tools"}</span>
                    <span className="dots"><span></span><span></span><span></span></span>
                  </span>
                </div>
                <div className="scan-bar" style={{ marginTop: 6, maxWidth: 220 }}></div>
              </div>
            </div>
          )}
        </div>
      </div>
      <Composer agentState={agentState} setAgentState={setAgentState} model={model} setModel={setModel} />
    </div>
  );
}

window.Chat = Chat;
