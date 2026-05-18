use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result, anyhow};
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use crate::types::{Chat, Project};

#[derive(Clone)]
pub struct ProxyDb {
    inner: Arc<Mutex<Connection>>,
}

impl ProxyDb {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).with_context(|| {
                format!("failed to create proxy DB directory {}", parent.display())
            })?;
        }
        let conn = Connection::open(path)
            .with_context(|| format!("failed to open proxy DB at {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(
            r#"
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
            "#,
        )?;
        Ok(Self {
            inner: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, name, path, created_at, last_opened_at
             FROM projects
             ORDER BY COALESCE(last_opened_at, created_at) DESC",
        )?;
        let rows = stmt.query_map([], project_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn add_project(&self, path: &str, name: Option<&str>) -> Result<Project> {
        let conn = self.lock()?;
        if let Some(existing) = conn
            .query_row(
                "SELECT id, name, path, created_at, last_opened_at FROM projects WHERE path = ?",
                [path],
                project_from_row,
            )
            .optional()?
        {
            return Ok(existing);
        }

        let now = now_ms();
        let project = Project {
            id: Uuid::new_v4().to_string(),
            name: name
                .filter(|name| !name.trim().is_empty())
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| fallback_name(path)),
            path: path.to_string(),
            created_at: now,
            last_opened_at: None,
        };
        conn.execute(
            "INSERT INTO projects (id, name, path, created_at, last_opened_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                project.id,
                project.name,
                project.path,
                project.created_at,
                project.last_opened_at
            ],
        )?;
        Ok(project)
    }

    pub fn get_project(&self, id: &str) -> Result<Option<Project>> {
        self.lock()?
            .query_row(
                "SELECT id, name, path, created_at, last_opened_at FROM projects WHERE id = ?",
                [id],
                project_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn touch_project(&self, id: &str) -> Result<()> {
        self.lock()?.execute(
            "UPDATE projects SET last_opened_at = ?1 WHERE id = ?2",
            params![now_ms(), id],
        )?;
        Ok(())
    }

    pub fn remove_project(&self, id: &str) -> Result<()> {
        self.lock()?
            .execute("DELETE FROM projects WHERE id = ?", [id])?;
        Ok(())
    }

    pub fn list_chats(&self, project_id: &str) -> Result<Vec<Chat>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, project_id, title, session_file, created_at, updated_at
             FROM chats
             WHERE project_id = ?
             ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([project_id], chat_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn create_chat(&self, project_id: &str, title: Option<&str>) -> Result<Chat> {
        if self.get_project(project_id)?.is_none() {
            return Err(anyhow!("project not found: {project_id}"));
        }
        let now = now_ms();
        let chat = Chat {
            id: Uuid::new_v4().to_string(),
            project_id: project_id.to_string(),
            title: title
                .filter(|title| !title.trim().is_empty())
                .unwrap_or("New chat")
                .to_string(),
            session_file: None,
            created_at: now,
            updated_at: now,
        };
        self.lock()?.execute(
            "INSERT INTO chats (id, project_id, title, session_file, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                chat.id,
                chat.project_id,
                chat.title,
                chat.session_file,
                chat.created_at,
                chat.updated_at
            ],
        )?;
        Ok(chat)
    }

    pub fn get_chat(&self, id: &str) -> Result<Option<Chat>> {
        self.lock()?
            .query_row(
                "SELECT id, project_id, title, session_file, created_at, updated_at
                 FROM chats WHERE id = ?",
                [id],
                chat_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn rename_chat(&self, id: &str, title: &str) -> Result<()> {
        self.lock()?.execute(
            "UPDATE chats SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, now_ms(), id],
        )?;
        Ok(())
    }

    pub fn set_session_file(&self, id: &str, session_file: &str) -> Result<()> {
        self.lock()?.execute(
            "UPDATE chats SET session_file = ?1, updated_at = ?2 WHERE id = ?3",
            params![session_file, now_ms(), id],
        )?;
        Ok(())
    }

    pub fn touch_chat(&self, id: &str) -> Result<()> {
        self.lock()?.execute(
            "UPDATE chats SET updated_at = ?1 WHERE id = ?2",
            params![now_ms(), id],
        )?;
        Ok(())
    }

    pub fn delete_chat(&self, id: &str) -> Result<()> {
        self.lock()?
            .execute("DELETE FROM chats WHERE id = ?", [id])?;
        Ok(())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.inner
            .lock()
            .map_err(|_| anyhow!("proxy DB mutex poisoned"))
    }
}

fn project_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        path: row.get(2)?,
        created_at: row.get(3)?,
        last_opened_at: row.get(4)?,
    })
}

fn chat_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Chat> {
    Ok(Chat {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        session_file: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn fallback_name(path: &str) -> String {
    PathBuf::from(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Project")
        .to_string()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> PathBuf {
        std::env::temp_dir().join(format!("pi-runtime-proxy-test-{}.db", Uuid::new_v4()))
    }

    #[test]
    fn persists_projects_and_chats() {
        let path = temp_db();
        let db = ProxyDb::open(&path).expect("open db");
        let project = db
            .add_project("D:/work/example", Some("Example"))
            .expect("add project");
        let same = db
            .add_project("D:/work/example", Some("Ignored"))
            .expect("idempotent add");
        assert_eq!(project.id, same.id);
        assert_eq!(db.list_projects().expect("list projects").len(), 1);

        let chat = db
            .create_chat(&project.id, Some("Initial"))
            .expect("create chat");
        db.rename_chat(&chat.id, "Renamed").expect("rename");
        db.set_session_file(&chat.id, "session.jsonl")
            .expect("session file");
        let loaded = db.get_chat(&chat.id).expect("get chat").expect("chat");
        assert_eq!(loaded.title, "Renamed");
        assert_eq!(loaded.session_file.as_deref(), Some("session.jsonl"));
        assert_eq!(db.list_chats(&project.id).expect("list chats").len(), 1);

        db.remove_project(&project.id).expect("remove project");
        assert!(db.list_chats(&project.id).expect("list chats").is_empty());
        let _ = std::fs::remove_file(path);
    }
}
