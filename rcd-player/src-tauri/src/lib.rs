mod db;
mod fs_scan;

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;
use serde::{Serialize, Deserialize};

struct AppState {
    db: Mutex<rusqlite::Connection>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SaveProgressArgs {
    path: String,
    position: f64,
    duration: f64,
    completed: bool,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CourseStats {
    total: usize,
    completed: usize,
    in_progress: usize,
    percent: f64,
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
fn open_folder(state: State<AppState>) -> Result<Option<fs_scan::FolderNode>, String> {
    // This is handled by the frontend using tauri-plugin-dialog
    // Here we just scan a provided path
    Err("Use scan_folder command with a path".into())
}

#[tauri::command]
fn scan_folder(path: String, state: State<AppState>) -> Result<fs_scan::FolderNode, String> {
    let p = PathBuf::from(&path);
    if !p.exists() || !p.is_dir() {
        return Err(format!("Path does not exist or is not a directory: {}", path));
    }

    let node = fs_scan::scan_folder(&p);

    // Save to recent folders
    if let Ok(conn) = state.db.lock() {
        db::save_course_folder(&conn, &node.path, &node.name).ok();
    }

    Ok(node)
}

#[tauri::command]
fn get_recent_folders(state: State<AppState>) -> Result<Vec<(String, String)>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::get_recent_folders(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_progress(args: SaveProgressArgs, state: State<AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let progress = db::VideoProgress {
        path: args.path,
        position: args.position,
        duration: args.duration,
        completed: args.completed,
        last_watched: Some(chrono::Utc::now().to_rfc3339()),
    };
    db::save_progress(&conn, &progress).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_progress(path: String, state: State<AppState>) -> Result<Option<db::VideoProgress>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::get_progress(&conn, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_course_stats(folder_path: String, state: State<AppState>) -> Result<CourseStats, String> {
    let p = PathBuf::from(&folder_path);
    if !p.exists() {
        return Ok(CourseStats { total: 0, completed: 0, in_progress: 0, percent: 0.0 });
    }

    let node = fs_scan::scan_folder(&p);
    let all_videos = fs_scan::get_all_videos_flat(&node);
    let total = all_videos.len();

    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let all_progress = db::get_all_progress(&conn).map_err(|e| e.to_string())?;

    let mut completed = 0;
    let mut in_progress = 0;

    for video in &all_videos {
        if let Some(prog) = all_progress.iter().find(|p| p.path == video.path) {
            if prog.completed {
                completed += 1;
            } else if prog.position > 5.0 {
                in_progress += 1;
            }
        }
    }

    let percent = if total > 0 {
        (completed as f64 / total as f64) * 100.0
    } else {
        0.0
    };

    Ok(CourseStats { total, completed, in_progress, percent })
}

#[tauri::command]
fn get_all_progress(state: State<AppState>) -> Result<Vec<db::VideoProgress>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::get_all_progress(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn convert_path_to_asset(path: String) -> String {
    // Tauri uses asset:// protocol for local files
    // The frontend converts file paths to asset:// URLs
    path
}

// ── App entry ─────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let conn = db::init_db().expect("Failed to initialize database");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            db: Mutex::new(conn),
        })
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            get_recent_folders,
            save_progress,
            get_progress,
            get_course_stats,
            get_all_progress,
            convert_path_to_asset,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
