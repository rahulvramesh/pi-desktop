/**
 * SQLite persistence for projects and chats.
 *
 * The DB lives at `app.getPath('userData')/pi-desktop.db`. We store *metadata*
 * only — projects (workspace folders the user added) and chats (conversation
 * records). The actual transcript for a chat is owned by the pi agent as a
 * JSONL session file on disk; we keep a pointer (`session_file`) so a chat can
 * be resumed via the RPC `switch_session` command. Keeping pi authoritative
 * for transcripts avoids a second, drifting copy of conversation state.
 *
 * better-sqlite3 is a native module: it must be rebuilt against Electron's ABI
 * (see scripts/electron-rebuild.mjs, wired as `postinstall`). It is in
 * `dependencies` so electron-vite's externalizeDepsPlugin keeps it out of the
 * bundle and `require`s it from node_modules at runtime.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { app } from 'electron';

import type { Chat, Project } from '../shared/ipc.js';

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  const file = join(app.getPath('userData'), 'pi-desktop.db');
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      path           TEXT NOT NULL UNIQUE,
      created_at     INTEGER NOT NULL,
      last_opened_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS chats (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title        TEXT NOT NULL,
      session_file TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chats_project
      ON chats(project_id, updated_at DESC);
  `);
  return db;
}

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  created_at: number;
  last_opened_at: number | null;
}

interface ChatRow {
  id: string;
  project_id: string;
  title: string;
  session_file: string | null;
  created_at: number;
  updated_at: number;
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  path: r.path,
  createdAt: r.created_at,
  lastOpenedAt: r.last_opened_at,
});

const toChat = (r: ChatRow): Chat => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  sessionFile: r.session_file,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const projectsRepo = {
  list(): Project[] {
    return (
      getDb()
        .prepare('SELECT * FROM projects ORDER BY COALESCE(last_opened_at, created_at) DESC')
        .all() as ProjectRow[]
    ).map(toProject);
  },

  /** Idempotent on `path`: re-adding an existing folder returns the existing row. */
  add(path: string, name: string): Project {
    const d = getDb();
    const existing = d.prepare('SELECT * FROM projects WHERE path = ?').get(path) as
      | ProjectRow
      | undefined;
    if (existing) return toProject(existing);
    const row: ProjectRow = {
      id: randomUUID(),
      name,
      path,
      created_at: Date.now(),
      last_opened_at: null,
    };
    d.prepare(
      'INSERT INTO projects (id, name, path, created_at, last_opened_at) VALUES (@id, @name, @path, @created_at, @last_opened_at)',
    ).run(row);
    return toProject(row);
  },

  get(id: string): Project | null {
    const r = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | ProjectRow
      | undefined;
    return r ? toProject(r) : null;
  },

  touch(id: string): void {
    getDb().prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run(Date.now(), id);
  },

  remove(id: string): void {
    getDb().prepare('DELETE FROM projects WHERE id = ?').run(id);
  },
};

export const chatsRepo = {
  list(projectId: string): Chat[] {
    return (
      getDb()
        .prepare('SELECT * FROM chats WHERE project_id = ? ORDER BY updated_at DESC')
        .all(projectId) as ChatRow[]
    ).map(toChat);
  },

  create(projectId: string, title: string): Chat {
    const now = Date.now();
    const row: ChatRow = {
      id: randomUUID(),
      project_id: projectId,
      title,
      session_file: null,
      created_at: now,
      updated_at: now,
    };
    getDb()
      .prepare(
        'INSERT INTO chats (id, project_id, title, session_file, created_at, updated_at) VALUES (@id, @project_id, @title, @session_file, @created_at, @updated_at)',
      )
      .run(row);
    return toChat(row);
  },

  get(id: string): Chat | null {
    const r = getDb().prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined;
    return r ? toChat(r) : null;
  },

  rename(id: string, title: string): void {
    getDb()
      .prepare('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, Date.now(), id);
  },

  /** Record the pi session file once the chat has run, and bump updated_at. */
  setSessionFile(id: string, sessionFile: string): void {
    getDb()
      .prepare('UPDATE chats SET session_file = ?, updated_at = ? WHERE id = ?')
      .run(sessionFile, Date.now(), id);
  },

  touch(id: string): void {
    getDb().prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  },

  delete(id: string): void {
    getDb().prepare('DELETE FROM chats WHERE id = ?').run(id);
  },
};

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
