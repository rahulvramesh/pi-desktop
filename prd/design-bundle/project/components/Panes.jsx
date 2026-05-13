// Right-pane Diff viewer, Terminal, File-preview panes
function DiffView() {
  const D = window.PiData;
  return (
    <div className="rp-body">
      <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
        <span className="pill ok"><Icon name="check" size={10} /> 3 files staged</span>
        <span className="mono tiny" style={{ color: "var(--add)" }}>+43</span>
        <span className="mono tiny" style={{ color: "var(--del)" }}>−2</span>
        <span className="spacer"></span>
        <button className="btn sm"><Icon name="gitMerge" size={11} /> Commit</button>
      </div>
      {D.diffFiles.map(f => (
        <div key={f.path} className="diff-file">
          <div className="diff-file-head">
            <Icon name="fileCode" size={13} style={{ color: "var(--ink-3)" }} />
            <span className="path">{f.path}</span>
            <span className="stats">
              <span className="add-count">+{f.add}</span>
              <span className="del-count">−{f.del}</span>
            </span>
          </div>
          {f.hunks.map((h, hi) => (
            <div key={hi} className="diff-hunk">
              <div className="diff-hunk-head">{h.header}</div>
              <pre className="code-block" style={{ margin: 0 }}>
                {h.lines.map((l, i) => {
                  const cls = l.t === "add" ? "add" : l.t === "del" ? "del" : "";
                  return (
                    <span key={i} className={cls}>
                      <span className="ln">{l.ln}</span>{l.text + "\n"}
                    </span>
                  );
                })}
              </pre>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Terminal({ embedded }) {
  const D = window.PiData;
  const tabs = [
    { id: "pi",   label: "pi", active: true },
    { id: "bun",  label: "bun test" },
    { id: "log",  label: "watch:logs" },
  ];
  return (
    <div className="terminal">
      <div className="terminal-head">
        {tabs.map(t => (
          <div key={t.id} className={"term-tab" + (t.active ? " active" : "")}>
            <Icon name="terminal" size={11} />
            {t.label}
            {t.active && <Icon name="x" size={10} style={{ color: "var(--ink-4)" }} />}
          </div>
        ))}
        <span className="term-tab" style={{ color: "var(--ink-4)" }}><Icon name="plus" size={11} /></span>
        <span className="spacer"></span>
        <span className="tiny muted mono">~/projects/openclaw · zsh</span>
      </div>
      <div className="terminal-body">
        {D.terminal.map((l, i) => (
          <div key={i} className="term-line">
            {l.kind === "prompt" && <><span className="term-prompt">{l.text}</span><span className="term-dim"> $ </span>{l.cursor && <span style={{ background: "var(--ink)", color: "transparent", animation: "pi-pulse 1s steps(2) infinite" }}>_</span>}</>}
            {l.kind === "cmd"    && <span className="term-cmd">{l.text}</span>}
            {l.kind === "out"    && <span className="term-out">{l.text}</span>}
            {l.kind === "dim"    && <span className="term-dim">{l.text}</span>}
            {l.kind === "ok"     && <span className="term-ok">{l.text}</span>}
            {l.kind === "err"    && <span className="term-err">{l.text}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function RightPane({ which, setWhich }) {
  return (
    <div className="right-pane">
      <div className="rp-head">
        <div className={"rp-tab" + (which === "diff" ? " active" : "")} onClick={() => setWhich("diff")}>
          <Icon name="git" size={11} style={{ marginRight: 4 }} /> Diff
        </div>
        <div className={"rp-tab" + (which === "term" ? " active" : "")} onClick={() => setWhich("term")}>
          <Icon name="terminal" size={11} style={{ marginRight: 4 }} /> Terminal
        </div>
        <div className={"rp-tab" + (which === "preview" ? " active" : "")} onClick={() => setWhich("preview")}>
          <Icon name="eye" size={11} style={{ marginRight: 4 }} /> Preview
        </div>
        <span className="spacer"></span>
        <button className="icon-btn" onClick={() => setWhich(null)}><Icon name="x" size={13} /></button>
      </div>
      {which === "diff" && <DiffView />}
      {which === "term" && <Terminal embedded />}
      {which === "preview" && (
        <div className="rp-body" style={{ padding: 20 }}>
          <div className="mono tiny muted" style={{ marginBottom: 10 }}>src/levels/Loader.ts</div>
          <pre className="code-block" style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8 }}>
{`  1  import { Parser } from "./Parser";
  2  import { LevelSchema, isV2, type Level } from "./schema";
  3  import { decodeTiles } from "./Tiles";
  4
  5  export class Loader {
  6    async load(path: string) {
  7      const buf = await Bun.file(path).arrayBuffer();
  8      const parsed = Parser.parse(buf);
  9      if (isV2(parsed)) {
 10        const tilesBuf = parsed.chunks.get("TILES");
 11        if (!tilesBuf) {
 12          throw new Error("v2 level missing TILES chunk");
 13        }
 14        return decodeTiles(tilesBuf);
 15      }
 16      return { tiles: parsed.tiles, meta: parsed.meta };
 17    }
 18  }`}
          </pre>
        </div>
      )}
    </div>
  );
}

window.RightPane = RightPane;
window.Terminal = Terminal;
window.DiffView = DiffView;
