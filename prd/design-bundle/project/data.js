// Sample data for the Pi desktop prototype.
// Pretend project: "openclaw" — a fictional game engine port the agent is helping refactor.

window.PiData = {
  user: { name: "M. Adler", initials: "MA", email: "m@earendil.com" },

  project: {
    name: "openclaw",
    path: "~/projects/openclaw",
    branch: "feat/level-loader-v2",
    gitStatus: { ahead: 0, behind: 0, dirty: 3 },
  },

  // File tree (path-keyed; expanded by default for the demo)
  files: [
    { type: "dir", name: ".pi", path: ".pi", children: [
      { type: "file", name: "AGENTS.md", path: ".pi/AGENTS.md" },
      { type: "file", name: "SYSTEM.md", path: ".pi/SYSTEM.md" },
      { type: "dir", name: "skills", path: ".pi/skills", children: [
        { type: "file", name: "level-format.md", path: ".pi/skills/level-format.md" },
        { type: "file", name: "asset-rip.md", path: ".pi/skills/asset-rip.md" },
      ]},
      { type: "dir", name: "themes", path: ".pi/themes", children: [
        { type: "file", name: "paper.json", path: ".pi/themes/paper.json" },
      ]},
    ]},
    { type: "dir", name: "src", path: "src", children: [
      { type: "dir", name: "engine", path: "src/engine", children: [
        { type: "file", name: "core.ts", path: "src/engine/core.ts" },
        { type: "file", name: "loop.ts", path: "src/engine/loop.ts" },
        { type: "file", name: "input.ts", path: "src/engine/input.ts" },
      ]},
      { type: "dir", name: "levels", path: "src/levels", children: [
        { type: "file", name: "Loader.ts", path: "src/levels/Loader.ts", status: "dirty", active: true },
        { type: "file", name: "Parser.ts", path: "src/levels/Parser.ts", status: "dirty" },
        { type: "file", name: "Tiles.ts", path: "src/levels/Tiles.ts" },
        { type: "file", name: "schema.ts", path: "src/levels/schema.ts", status: "added" },
      ]},
      { type: "dir", name: "render", path: "src/render", children: [
        { type: "file", name: "Sprite.ts", path: "src/render/Sprite.ts" },
        { type: "file", name: "Atlas.ts", path: "src/render/Atlas.ts" },
      ]},
      { type: "file", name: "main.ts", path: "src/main.ts" },
    ]},
    { type: "dir", name: "assets", path: "assets", children: [
      { type: "file", name: "level-01.wwd", path: "assets/level-01.wwd" },
      { type: "file", name: "level-02.wwd", path: "assets/level-02.wwd" },
      { type: "file", name: "atlas.png", path: "assets/atlas.png" },
    ]},
    { type: "dir", name: "tests", path: "tests", children: [
      { type: "file", name: "loader.test.ts", path: "tests/loader.test.ts" },
    ]},
    { type: "file", name: "AGENTS.md", path: "AGENTS.md" },
    { type: "file", name: "package.json", path: "package.json" },
    { type: "file", name: "tsconfig.json", path: "tsconfig.json" },
    { type: "file", name: "README.md", path: "README.md" },
  ],

  // Sessions list — left rail
  sessions: [
    { id: "s1", title: "Level loader v2", time: "now",         model: "claude-sonnet-4.5", msgs: 24, active: true,  bookmark: true },
    { id: "s2", title: "Atlas blitting perf",       time: "2h ago",   model: "gpt-5",            msgs: 12 },
    { id: "s3", title: "Add skill: asset-rip",      time: "yesterday",model: "kimi-coding",      msgs: 8,  bookmark: true },
    { id: "s4", title: "Fix Windows path joins",    time: "Wed",      model: "claude-sonnet-4.5",msgs: 31 },
    { id: "s5", title: "Wire SDL3 input backend",   time: "Tue",      model: "deepseek-v4",      msgs: 19 },
    { id: "s6", title: "Migrate build to Bun",      time: "May 8",    model: "claude-opus-4.1",  msgs: 47 },
  ],

  // The main conversation thread
  messages: [
    {
      id: "m1", role: "user", time: "10:42",
      text: "We're getting `Cannot read properties of undefined (reading 'tiles')` when loading level-02.wwd. Loader probably isn't handling the v2 chunk header. Read src/levels/Loader.ts and the schema, figure out what's going on, and propose a fix. Add a regression test."
    },
    {
      id: "m2", role: "agent", time: "10:42",
      text: "Looking at the level loader. I'll start by reading the current implementation and the on-disk format spec.",
      tools: [
        { name: "read", arg: "src/levels/Loader.ts", status: "ok", time: "0.4s",
          preview:
`  1  import { Parser } from "./Parser";
  2  import { LevelSchema } from "./schema";
  3
  4  export class Loader {
  5    async load(path: string) {
  6      const buf = await Bun.file(path).arrayBuffer();
  7      const parsed = Parser.parse(buf);
  8      return parsed.tiles;     // <- v1-only
  9    }
 10  }`
        },
        { name: "read", arg: ".pi/skills/level-format.md", status: "ok", time: "0.2s",
          preview:
`# Claw level format (WWD)

## v1 (legacy)
- 64-byte header
- single TILES chunk
- parser returns { tiles, meta }

## v2 (Claw Remastered)
- 128-byte header, signature "WWD2"
- chunked: TILES, OBJX, MUSC, METZ
- parser returns { chunks: Map<string, Buffer> }`
        },
        { name: "grep", arg: "'WWD2' src/levels/", status: "ok", time: "0.1s",
          preview: `src/levels/Parser.ts:18:  if (sig === "WWD2") return this.parseV2(buf);\nsrc/levels/Parser.ts:42:  parseV2(buf: ArrayBuffer) {`
        },
      ]
    },
    {
      id: "m3", role: "agent", time: "10:43",
      text: "Found it. The Parser already detects v2 and returns a `{ chunks }` shape, but `Loader.load` unconditionally reaches for `.tiles` — which doesn't exist on v2 outputs. The fix:\n\n1. Branch on the parser output shape\n2. For v2, pull `chunks.get(\"TILES\")` and re-decode into the same `{ tiles, meta }` shape\n3. Add a typed schema for both\n\nI'll write the change, then add a regression test that loads `level-02.wwd`.",
      tools: [
        { name: "edit", arg: "src/levels/schema.ts", status: "ok", time: "0.3s",
          stats: { add: 14, del: 0 },
          preview:
`+ export type LevelV1 = { tiles: Tile[]; meta: Meta };
+ export type LevelV2 = { chunks: Map<string, Uint8Array> };
+ export type Level = LevelV1 | LevelV2;
+
+ export const isV2 = (l: Level): l is LevelV2 =>
+   "chunks" in l;`
        },
        { name: "edit", arg: "src/levels/Loader.ts", status: "ok", time: "0.4s",
          stats: { add: 11, del: 2 },
          preview:
`  async load(path: string) {
    const buf = await Bun.file(path).arrayBuffer();
    const parsed = Parser.parse(buf);
-   return parsed.tiles;
+   if (isV2(parsed)) {
+     const tilesBuf = parsed.chunks.get("TILES");
+     if (!tilesBuf) throw new Error("v2 level missing TILES chunk");
+     return decodeTiles(tilesBuf);
+   }
+   return { tiles: parsed.tiles, meta: parsed.meta };
  }`
        },
        { name: "edit", arg: "tests/loader.test.ts", status: "ok", time: "0.3s",
          stats: { add: 18, del: 0 } },
        { name: "bash", arg: "bun test tests/loader.test.ts", status: "ok", time: "1.8s",
          preview:
`bun test v1.2.3 (linux x64)

tests/loader.test.ts:
  loader > loads v1 level                  [pass]  3ms
  loader > loads v2 level with chunks      [pass]  8ms
  loader > rejects v2 without TILES chunk  [pass]  2ms

 3 pass
 0 fail
 expect() called: 9
Ran 3 tests across 1 files. [120ms]`
        },
      ]
    },
    {
      id: "m4", role: "agent", time: "10:44",
      text: "All three tests pass. Summary of the change:\n\n• `schema.ts` — discriminated union for v1/v2 levels and an `isV2` guard\n• `Loader.ts` — branches on shape, extracts TILES chunk for v2\n• `loader.test.ts` — three cases incl. the original repro\n\nThe error you were seeing on `level-02.wwd` is now reproduced and caught by the second test. Want me to write up a brief migration note in `.pi/skills/level-format.md` so future you remembers the shape difference?"
    },
    {
      id: "m5", role: "user", time: "10:46",
      text: "Yes please. Also bump the version in package.json to 0.4.2."
    },
    {
      id: "m6", role: "agent", time: "10:46",
      text: "On it.",
      running: true,
      tools: [
        { name: "edit", arg: ".pi/skills/level-format.md", status: "ok", time: "0.2s", stats: { add: 6, del: 0 } },
        { name: "edit", arg: "package.json", status: "ok", time: "0.1s", stats: { add: 1, del: 1 } },
        { name: "bash", arg: "git diff --stat", status: "run", time: "—" },
      ]
    },
  ],

  // Available models
  models: [
    { id: "claude-sonnet-4.5",  label: "Claude Sonnet 4.5",  provider: "anthropic",  active: true },
    { id: "claude-opus-4.1",    label: "Claude Opus 4.1",    provider: "anthropic" },
    { id: "gpt-5",              label: "GPT-5",              provider: "openai" },
    { id: "gpt-5-mini",         label: "GPT-5 mini",         provider: "openai" },
    { id: "gemini-2.5-pro",     label: "Gemini 2.5 Pro",     provider: "google" },
    { id: "kimi-coding",        label: "Kimi K2 (coding)",   provider: "moonshot" },
    { id: "deepseek-v4",        label: "DeepSeek V4",        provider: "deepseek" },
    { id: "qwen3-coder",        label: "Qwen3 Coder",        provider: "qwen" },
    { id: "ollama-local",       label: "llama-3.3-70b",      provider: "ollama" },
  ],

  // Terminal output
  terminal: [
    { kind: "prompt", text: "~/projects/openclaw" },
    { kind: "cmd", text: "bun test" },
    { kind: "out", text: "bun test v1.2.3 (linux x64)\n" },
    { kind: "dim", text: "src/levels/Loader.test.ts:" },
    { kind: "out", text: "  loader > loads v1 level                  [pass]  3ms" },
    { kind: "out", text: "  loader > loads v2 level with chunks      [pass]  8ms" },
    { kind: "out", text: "  loader > rejects v2 without TILES chunk  [pass]  2ms" },
    { kind: "ok",  text: "\n 3 pass" },
    { kind: "dim", text: " 0 fail" },
    { kind: "dim", text: " expect() called: 9" },
    { kind: "dim", text: "Ran 3 tests across 1 files. [120ms]" },
    { kind: "prompt", text: "~/projects/openclaw" },
    { kind: "cmd", text: "git diff --stat" },
    { kind: "out", text: " src/levels/Loader.ts   |  13 ++++++---\n src/levels/schema.ts   |  14 +++++++++++\n tests/loader.test.ts   |  18 +++++++++++++++\n .pi/skills/level-format.md |  6 ++++\n package.json           |   2 +-\n 5 files changed, 49 insertions(+), 4 deletions(-)" },
    { kind: "prompt", text: "~/projects/openclaw", cursor: true },
  ],

  // Diff view sample
  diffFiles: [
    {
      path: "src/levels/Loader.ts",
      add: 11, del: 2,
      hunks: [
        { header: "@@ -3,8 +3,17 @@ export class Loader {", lines: [
          { t: "ctx", ln: " 4", text: "  async load(path: string) {" },
          { t: "ctx", ln: " 5", text: "    const buf = await Bun.file(path).arrayBuffer();" },
          { t: "ctx", ln: " 6", text: "    const parsed = Parser.parse(buf);" },
          { t: "del", ln: " 7", text: "-   return parsed.tiles;" },
          { t: "add", ln: " 7", text: "+   if (isV2(parsed)) {" },
          { t: "add", ln: " 8", text: "+     const tilesBuf = parsed.chunks.get(\"TILES\");" },
          { t: "add", ln: " 9", text: "+     if (!tilesBuf) throw new Error(\"v2 level missing TILES chunk\");" },
          { t: "add", ln: "10", text: "+     return decodeTiles(tilesBuf);" },
          { t: "add", ln: "11", text: "+   }" },
          { t: "add", ln: "12", text: "+   return { tiles: parsed.tiles, meta: parsed.meta };" },
          { t: "ctx", ln: "13", text: "  }" },
        ]},
      ],
    },
    {
      path: "src/levels/schema.ts",
      add: 14, del: 0,
      hunks: [
        { header: "@@ -0,0 +1,14 @@", lines: [
          { t: "add", ln: " 1", text: "+ import { Tile, Meta } from \"./Tiles\";" },
          { t: "add", ln: " 2", text: "+" },
          { t: "add", ln: " 3", text: "+ export type LevelV1 = { tiles: Tile[]; meta: Meta };" },
          { t: "add", ln: " 4", text: "+ export type LevelV2 = { chunks: Map<string, Uint8Array> };" },
          { t: "add", ln: " 5", text: "+ export type Level = LevelV1 | LevelV2;" },
          { t: "add", ln: " 6", text: "+" },
          { t: "add", ln: " 7", text: "+ export const isV2 = (l: Level): l is LevelV2 =>" },
          { t: "add", ln: " 8", text: "+   \"chunks\" in l;" },
        ]},
      ],
    },
    {
      path: "tests/loader.test.ts",
      add: 18, del: 0,
      hunks: [
        { header: "@@ -1,0 +1,18 @@", lines: [
          { t: "add", ln: " 1", text: "+ import { test, expect } from \"bun:test\";" },
          { t: "add", ln: " 2", text: "+ import { Loader } from \"../src/levels/Loader\";" },
          { t: "add", ln: " 3", text: "+" },
          { t: "add", ln: " 4", text: "+ test(\"loads v2 level with chunks\", async () => {" },
          { t: "add", ln: " 5", text: "+   const l = new Loader();" },
          { t: "add", ln: " 6", text: "+   const out = await l.load(\"assets/level-02.wwd\");" },
          { t: "add", ln: " 7", text: "+   expect(out.tiles.length).toBeGreaterThan(0);" },
          { t: "add", ln: " 8", text: "+ });" },
        ]},
      ],
    },
  ],

  history: [
    { id: "s1", title: "Level loader v2",          path: "openclaw",  model: "claude-sonnet-4.5", time: "now",        msgs: 24, bookmark: true },
    { id: "s2", title: "Atlas blitting perf",      path: "openclaw",  model: "gpt-5",             time: "2h ago",     msgs: 12 },
    { id: "s3", title: "Add skill: asset-rip",     path: "openclaw",  model: "kimi-coding",       time: "yesterday",  msgs: 8,  bookmark: true },
    { id: "s4", title: "Fix Windows path joins",   path: "openclaw",  model: "claude-sonnet-4.5", time: "Wed 14:02",  msgs: 31 },
    { id: "s5", title: "Wire SDL3 input backend",  path: "openclaw",  model: "deepseek-v4",       time: "Tue 09:11",  msgs: 19 },
    { id: "s6", title: "Migrate build to Bun",     path: "openclaw",  model: "claude-opus-4.1",   time: "May 8",      msgs: 47 },
    { id: "s7", title: "Termdraw extension trial", path: "scratchpad",model: "gpt-5-mini",        time: "May 6",      msgs: 9 },
    { id: "s8", title: "Codemod: classes → fns",   path: "openclaw",  model: "claude-sonnet-4.5", time: "May 5",      msgs: 22 },
    { id: "s9", title: "Audit dependencies",       path: "openclaw",  model: "gemini-2.5-pro",    time: "May 3",      msgs: 14 },
    { id:"s10", title: "First-pass project setup", path: "openclaw",  model: "claude-sonnet-4.5", time: "Apr 28",     msgs: 41, bookmark: true },
  ],
};
