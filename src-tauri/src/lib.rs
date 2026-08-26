pub mod scanner;

use std::path::PathBuf;

use scanner::ProjectGraph;

#[tauri::command]
async fn scan_project(path: String) -> Result<ProjectGraph, String> {
    // Walking and parsing a large tree blocks for a while; keep it off the main thread.
    tauri::async_runtime::spawn_blocking(move || scanner::scan(&PathBuf::from(path)))
        .await
        .map_err(|e| format!("scan task failed: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .invoke_handler(tauri::generate_handler![scan_project])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
