/**
 * Hardcoded file tree for the Files tab in P1–P3 (no real filesystem access
 * from the renderer; later phases will surface project files through the
 * agent's read/glob tools).
 */

export interface FileNode {
  type: 'file' | 'dir';
  name: string;
  path: string;
  status?: 'dirty' | 'added';
  children?: FileNode[];
}

export const FILE_TREE: FileNode[] = [
  {
    type: 'dir',
    name: '.pi',
    path: '.pi',
    children: [
      { type: 'file', name: 'AGENTS.md', path: '.pi/AGENTS.md' },
      { type: 'file', name: 'SYSTEM.md', path: '.pi/SYSTEM.md' },
      {
        type: 'dir',
        name: 'skills',
        path: '.pi/skills',
        children: [
          { type: 'file', name: 'level-format.md', path: '.pi/skills/level-format.md' },
          { type: 'file', name: 'asset-rip.md', path: '.pi/skills/asset-rip.md' },
        ],
      },
    ],
  },
  {
    type: 'dir',
    name: 'src',
    path: 'src',
    children: [
      {
        type: 'dir',
        name: 'engine',
        path: 'src/engine',
        children: [
          { type: 'file', name: 'core.ts', path: 'src/engine/core.ts' },
          { type: 'file', name: 'loop.ts', path: 'src/engine/loop.ts' },
          { type: 'file', name: 'input.ts', path: 'src/engine/input.ts' },
        ],
      },
      {
        type: 'dir',
        name: 'levels',
        path: 'src/levels',
        children: [
          { type: 'file', name: 'Loader.ts', path: 'src/levels/Loader.ts', status: 'dirty' },
          { type: 'file', name: 'Parser.ts', path: 'src/levels/Parser.ts', status: 'dirty' },
          { type: 'file', name: 'Tiles.ts', path: 'src/levels/Tiles.ts' },
          { type: 'file', name: 'schema.ts', path: 'src/levels/schema.ts', status: 'added' },
        ],
      },
    ],
  },
  {
    type: 'dir',
    name: 'tests',
    path: 'tests',
    children: [{ type: 'file', name: 'loader.test.ts', path: 'tests/loader.test.ts' }],
  },
  { type: 'file', name: 'AGENTS.md', path: 'AGENTS.md' },
  { type: 'file', name: 'package.json', path: 'package.json' },
  { type: 'file', name: 'README.md', path: 'README.md' },
];
