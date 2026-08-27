pub mod scanner;
pub mod source;
pub mod symbols;
pub mod tsconfig;

use std::path::PathBuf;

use scanner::ProjectGraph;

/// Read a declaration's source, or a whole file when `name` is omitted.
#[tauri::command]
async fn read_source(
    path: String,
    name: Option<String>,
    container: Option<String>,
) -> Result<source::SourceView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        source::read(
            std::path::Path::new(&path),
            name.as_deref(),
            container.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("read task failed: {e}"))?
}

/// How far a cached scan has drifted from what is on disk.
#[tauri::command]
async fn check_freshness(
    path: String,
    fingerprint: Vec<scanner::FileStamp>,
) -> Result<scanner::Freshness, String> {
    // Only stats the tree — no parsing — but it still walks it, so keep it off
    // the main thread like the scan itself.
    tauri::async_runtime::spawn_blocking(move || {
        scanner::compare(&PathBuf::from(path), &fingerprint)
    })
    .await
    .map_err(|e| format!("freshness task failed: {e}"))?
}

#[tauri::command]
async fn scan_project(path: String) -> Result<ProjectGraph, String> {
    // Walking and parsing a large tree blocks for a while; keep it off the main thread.
    tauri::async_runtime::spawn_blocking(move || scanner::scan(&PathBuf::from(path)))
        .await
        .map_err(|e| format!("scan task failed: {e}"))?
}

/// Where the scan cache lives, relative to the app's data directory.
const DB_URL: &str = "sqlite:meridian.db";

fn migrations() -> Vec<tauri_plugin_sql::Migration> {
    use tauri_plugin_sql::{Migration, MigrationKind};

    vec![Migration {
        version: 1,
        description: "create scan cache",
        sql: "CREATE TABLE scans (
                  path       TEXT PRIMARY KEY,
                  graph      TEXT NOT NULL,
                  scanned_at TEXT NOT NULL
              );
              CREATE TABLE app_state (
                  key   TEXT PRIMARY KEY,
                  value TEXT NOT NULL
              );",
        kind: MigrationKind::Up,
    }]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::new()
                .add_migrations(DB_URL, migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            scan_project,
            read_source,
            check_freshness
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
