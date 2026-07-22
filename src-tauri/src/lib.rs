mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .manage(commands::CancelRegistry::default())
        .invoke_handler(tauri::generate_handler![
            commands::is_process_running,
            commands::dir_size,
            commands::batch_dir_sizes,
            commands::allow_library_scope,
            commands::canonicalize_path,
            commands::path_identity,
            commands::extract_tarball,
            commands::download_file,
            commands::cancel_download,
            commands::remove_orphan_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running protium");
}
