use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct VideoFile {
    pub name: String,
    pub path: String,
    pub relative_path: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FolderNode {
    pub name: String,
    pub path: String,
    pub children: Vec<FolderNode>,
    pub videos: Vec<VideoFile>,
}

static VIDEO_EXTENSIONS: &[&str] = &["mp4", "mkv", "mov", "avi", "webm", "m4v"];

fn is_video(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

pub fn scan_folder(root: &Path) -> FolderNode {
    build_tree(root, root)
}

fn build_tree(root: &Path, current: &Path) -> FolderNode {
    let name = current
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Unknown")
        .to_string();

    let path = canonicalize_path(current);
    let mut videos = Vec::new();
    let mut children_map: std::collections::BTreeMap<String, FolderNode> = std::collections::BTreeMap::new();

    if let Ok(entries) = std::fs::read_dir(current) {
        let mut entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());

        for entry in entries {
            let entry_path = entry.path();

            if entry_path.is_dir() {
                // Skip hidden dirs
                if entry_path.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with('.'))
                    .unwrap_or(false)
                {
                    continue;
                }

                let child = build_tree(root, &entry_path);
                // Only include dirs that have videos somewhere
                if !child.videos.is_empty() || !child.children.is_empty() {
                    let child_name = child.name.clone();
                    children_map.insert(child_name, child);
                }
            } else if is_video(&entry_path) {
                let video_path = canonicalize_path(&entry_path);
                let relative = entry_path
                    .strip_prefix(root)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();

                videos.push(VideoFile {
                    name: entry_path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string(),
                    path: video_path,
                    relative_path: relative,
                });
            }
        }
    }

    FolderNode {
        name,
        path,
        children: children_map.into_values().collect(),
        videos,
    }
}

pub fn get_all_videos_flat(node: &FolderNode) -> Vec<VideoFile> {
    let mut result = Vec::new();
    collect_videos(node, &mut result);
    result
}

fn collect_videos(node: &FolderNode, result: &mut Vec<VideoFile>) {
    result.extend(node.videos.clone());
    for child in &node.children {
        collect_videos(child, result);
    }
}

fn canonicalize_path(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}
