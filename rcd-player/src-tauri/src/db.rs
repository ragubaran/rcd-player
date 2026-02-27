use rusqlite::{Connection, Result, params};
use std::path::PathBuf;
use dirs;

pub fn get_db_path() -> PathBuf {
    let data_dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("CoursePlayer");
    std::fs::create_dir_all(&data_dir).ok();
    data_dir.join("progress.db")
}

pub fn init_db() -> Result<Connection> {
    let path = get_db_path();
    let conn = Connection::open(&path)?;

    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS video_progress (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            position REAL NOT NULL DEFAULT 0,
            duration REAL NOT NULL DEFAULT 0,
            completed INTEGER NOT NULL DEFAULT 0,
            last_watched TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS course_folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            last_opened TEXT DEFAULT (datetime('now'))
        );
    ")?;

    Ok(conn)
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct VideoProgress {
    pub path: String,
    pub position: f64,
    pub duration: f64,
    pub completed: bool,
    pub last_watched: Option<String>,
}

pub fn save_progress(conn: &Connection, progress: &VideoProgress) -> Result<()> {
    conn.execute(
        "INSERT INTO video_progress (path, position, duration, completed, last_watched, updated_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now'))
         ON CONFLICT(path) DO UPDATE SET
           position = excluded.position,
           duration = excluded.duration,
           completed = excluded.completed,
           last_watched = excluded.last_watched,
           updated_at = excluded.updated_at",
        params![
            progress.path,
            progress.position,
            progress.duration,
            progress.completed as i32,
            progress.last_watched,
        ],
    )?;
    Ok(())
}

pub fn get_progress(conn: &Connection, path: &str) -> Result<Option<VideoProgress>> {
    let mut stmt = conn.prepare(
        "SELECT path, position, duration, completed, last_watched FROM video_progress WHERE path = ?1"
    )?;

    let result = stmt.query_row(params![path], |row| {
        Ok(VideoProgress {
            path: row.get(0)?,
            position: row.get(1)?,
            duration: row.get(2)?,
            completed: row.get::<_, i32>(3)? != 0,
            last_watched: row.get(4)?,
        })
    });

    match result {
        Ok(p) => Ok(Some(p)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn get_all_progress(conn: &Connection) -> Result<Vec<VideoProgress>> {
    let mut stmt = conn.prepare(
        "SELECT path, position, duration, completed, last_watched FROM video_progress"
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(VideoProgress {
            path: row.get(0)?,
            position: row.get(1)?,
            duration: row.get(2)?,
            completed: row.get::<_, i32>(3)? != 0,
            last_watched: row.get(4)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

pub fn save_course_folder(conn: &Connection, path: &str, name: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO course_folders (path, name, last_opened)
         VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(path) DO UPDATE SET last_opened = datetime('now')",
        params![path, name],
    )?;
    Ok(())
}

pub fn get_recent_folders(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT path, name FROM course_folders ORDER BY last_opened DESC LIMIT 10"
    )?;

    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}
