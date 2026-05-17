/**
 * IPC bridge for projects, chats, the folder picker, and the on-disk file
 * tree. Pure data + filesystem; agent/backend lifecycle lives in
 * agent-bridge.ts. The renderer is sandboxed and has no fs/dialog access, so
 * everything funnels through these typed handlers.
 */

import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';

import { dialog, ipcMain } from 'electron';

import { IPC, type Chat, type FsEntry, type Project } from '../shared/ipc.js';
import { chatsRepo, projectsRepo } from './db.js';

/** Directories never worth showing/scanning in the Files pane. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'out',
  'build',
  '.next',
  '.cache',
  '.turbo',
  'coverage',
  '.venv',
  '__pycache__',
]);

const MAX_DEPTH = 6;
const MAX_ENTRIES = 4_000;

const execFileAsync = promisify(execFile);

/** Parse `git status --porcelain --branch` into a branch + modified count. */
async function gitStatus(cwd: string): Promise<{ branch: string | null; modified: number }> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--branch'], {
      cwd,
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const lines = stdout.split('\n');
    const head = lines[0] ?? '';
    let branch: string | null = null;
    if (head.startsWith('## ')) {
      const raw = head.slice(3).trim();
      if (raw.startsWith('No commits yet on ')) branch = raw.slice('No commits yet on '.length);
      else if (raw.startsWith('HEAD (no branch)')) branch = 'HEAD';
      else branch = raw.split('...')[0] ?? null;
    }
    const modified = lines.slice(1).filter((l) => l.trim().length > 0).length;
    return { branch, modified };
  } catch {
    // Not a git repo, git not installed, or timeout — render nothing.
    return { branch: null, modified: 0 };
  }
}

/** Ordered favicon-ish candidates relative to the project root. */
const ICON_CANDIDATES = [
  'favicon.ico',
  'favicon.svg',
  'favicon.png',
  'public/favicon.ico',
  'public/favicon.svg',
  'public/favicon.png',
  'static/favicon.ico',
  'static/favicon.png',
  'app/favicon.ico',
  'src/favicon.ico',
  'src/assets/favicon.ico',
  'assets/favicon.ico',
  'resources/icon.png',
  'build/icon.png',
];

const ICON_MIME: Record<string, string> = {
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const MAX_ICON_BYTES = 512 * 1024;

async function projectIcon(root: string): Promise<string | null> {
  for (const rel of ICON_CANDIDATES) {
    const full = join(root, rel);
    try {
      const s = await stat(full);
      if (!s.isFile() || s.size === 0 || s.size > MAX_ICON_BYTES) continue;
      const mime = ICON_MIME[extname(full).toLowerCase()];
      if (!mime) continue;
      const buf = await readFile(full);
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch {
      // missing candidate — try the next
    }
  }
  return null;
}

async function readTree(root: string): Promise<FsEntry[]> {
  let count = 0;

  async function walk(dir: string, depth: number): Promise<FsEntry[]> {
    if (depth > MAX_DEPTH || count >= MAX_ENTRIES) return [];
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const dirs: FsEntry[] = [];
    const files: FsEntry[] = [];
    for (const d of dirents) {
      if (count >= MAX_ENTRIES) break;
      const name = d.name;
      if (d.isDirectory() && SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      count++;
      if (d.isDirectory()) {
        dirs.push({
          type: 'dir',
          name,
          path: full,
          children: await walk(full, depth + 1),
        });
      } else if (d.isFile()) {
        files.push({ type: 'file', name, path: full });
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  }

  return walk(root, 0);
}

export function installProjectsBridge(): void {
  ipcMain.handle(IPC.ProjectsList, async (): Promise<Project[]> => projectsRepo.list());

  ipcMain.handle(
    IPC.ProjectsPick,
    async (): Promise<{ path: string; name: string } | null> => {
      const res = await dialog.showOpenDialog({
        title: 'Add project folder',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (res.canceled || res.filePaths.length === 0) return null;
      const path = res.filePaths[0]!;
      return { path, name: basename(path) || path };
    },
  );

  ipcMain.handle(
    IPC.ProjectsAdd,
    async (_e, path: string, name?: string): Promise<Project> =>
      projectsRepo.add(path, name?.trim() || basename(path) || path),
  );

  ipcMain.handle(IPC.ProjectsRemove, async (_e, id: string): Promise<void> => {
    projectsRepo.remove(id);
  });

  ipcMain.handle(
    IPC.ChatsList,
    async (_e, projectId: string): Promise<Chat[]> => chatsRepo.list(projectId),
  );

  ipcMain.handle(
    IPC.ChatsCreate,
    async (_e, projectId: string, title?: string): Promise<Chat> =>
      chatsRepo.create(projectId, title?.trim() || 'New chat'),
  );

  ipcMain.handle(IPC.ChatsRename, async (_e, id: string, title: string): Promise<void> => {
    chatsRepo.rename(id, title);
  });

  ipcMain.handle(IPC.ChatsDelete, async (_e, id: string): Promise<void> => {
    chatsRepo.delete(id);
  });

  ipcMain.handle(IPC.FsTree, async (_e, rootPath: string): Promise<FsEntry[]> =>
    readTree(rootPath),
  );

  ipcMain.handle(
    IPC.GitStatus,
    async (_e, cwd: string): Promise<{ branch: string | null; modified: number }> =>
      gitStatus(cwd),
  );

  ipcMain.handle(
    IPC.ProjectIcon,
    async (_e, path: string): Promise<string | null> => projectIcon(path),
  );
}
