mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // appimage-wayland-fix: 01-wayland-fix.sh lädt die system-libwayland-client
    // per LD_PRELOAD — die lib ist beim prozess-start bereits geladen, die
    // env-var wird danach nur noch an kind-prozesse vererbt. dort tötet sie
    // externe aufrufer (xdg-open → firefox crasht lautlos, protondb-link und
    // play-button wirken tot). entfernen nach dem start.
    std::env::remove_var("LD_PRELOAD");
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(not(mobile))]
            {
                use tauri::{
                    utils::config::{Color, WebviewUrl},
                    WebviewWindowBuilder,
                };
                // fenster wird hier statt in tauri.conf gebaut, weil nur der
                // builder einen navigation-handler setzen kann: eigener origin
                // durchlassen, alles externe blocken — externe links gehören
                // in den system-browser (openExternal), nicht in die webview
                // (rechtsklick-open-link liess die app sonst auf protondb.com
                // hängen, kein zurück).
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("protium")
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(960.0, 600.0)
                    .background_color(Color(10, 11, 17, 255))
                    .on_navigation(|url| {
                        let app_origin = url.scheme() == "tauri"
                            || (cfg!(dev) && url.scheme() == "http" && url.host_str() == Some("localhost"));
                        app_origin || !matches!(url.scheme(), "http" | "https" | "steam")
                    })
                    .build()?;
            }
            Ok(())
        })
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
            commands::remove_trash_entry,
            commands::list_trash_entries,
            commands::write_steam_file,
            commands::remove_compat_tool,
        ])
        .run(tauri::generate_context!())
        .expect("error while running protium");
}
