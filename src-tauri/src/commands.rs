// protium — rust-commands (bewusst minimale rust-fläche).
// R-1/R-2/R-3/R-4/R-5/R-6. downloads + extraktion laufen in rust, weil beides
// im webview zu teuer/unmöglich wäre.

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha512};
use sysinfo::System;
use tauri::{AppHandle, Emitter};
use tauri_plugin_fs::FsExt;
use tokio::io::AsyncWriteExt;

/// laufende downloads, die abgebrochen werden sollen (id = download_id).
#[derive(Default)]
pub struct CancelRegistry(pub Mutex<HashSet<String>>);

/// markiert einen laufenden download zum abbruch; R-4 pollt das zwischen chunks.
#[tauri::command]
pub fn cancel_download(state: tauri::State<'_, CancelRegistry>, download_id: String) {
    if let Ok(mut set) = state.0.lock() {
        set.insert(download_id);
    }
}

#[derive(Serialize, Clone)]
struct DownloadProgress {
    id: String,
    downloaded: u64,
    total: Option<u64>,
}

/// R-1: GE-proton .tar.gz nach `dest` (= compatibilitytools.d) entpacken.
/// entpackt in ein temp-geschwisterverzeichnis IM ZIEL-FS (EXDEV-sicher),
/// verschiebt dann die top-level-verzeichnisse per rename ins ziel, räumt temp auf.
#[tauri::command]
pub async fn extract_tarball(src: String, dest: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || extract_blocking(&src, &dest))
        .await
        .map_err(|e| e.to_string())?
}

fn extract_blocking(src: &str, dest_dir: &str) -> Result<(), String> {
    use flate2::read::GzDecoder;
    use tar::Archive;

    let dest = Path::new(dest_dir);
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;

    // temp im selben verzeichnis wie ziel → rename bleibt innerhalb des fs (kein EXDEV)
    let tmp = dest.join(format!(".protium-extract-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;

    let result = (|| -> Result<(), String> {
        let f = fs::File::open(src).map_err(|e| e.to_string())?;
        let mut ar = Archive::new(GzDecoder::new(f));
        ar.unpack(&tmp).map_err(|e| e.to_string())?;
        // top-level-einträge (i. d. R. genau der versionsordner) ins ziel renamen
        for entry in fs::read_dir(&tmp).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let target = dest.join(entry.file_name());
            if target.exists() {
                let _ = fs::remove_dir_all(&target);
            }
            fs::rename(entry.path(), &target).map_err(|e| e.to_string())?;
        }
        Ok(())
    })();

    let _ = fs::remove_dir_all(&tmp);
    result
}

/// R-2: läuft ein prozess mit diesem namen? (steam-läuft-check, INV-1a)
#[tauri::command]
pub fn is_process_running(name: String) -> Result<bool, String> {
    let sys = System::new_all();
    let target = name.to_lowercase();
    Ok(sys
        .processes()
        .values()
        .any(|p| p.name().to_string_lossy().to_lowercase().contains(&target)))
}

/// R-3: rekursive verzeichnisgröße in bytes.
#[tauri::command]
pub fn dir_size(path: String) -> Result<u64, String> {
    Ok(dir_size_impl(Path::new(&path)))
}

fn dir_size_impl(path: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(rd) = fs::read_dir(path) {
        for entry in rd.flatten() {
            match entry.file_type() {
                Ok(ft) if ft.is_dir() => total += dir_size_impl(&entry.path()),
                Ok(ft) if ft.is_file() => {
                    if let Ok(md) = entry.metadata() {
                        total += md.len();
                    }
                }
                _ => {}
            }
        }
    }
    total
}

/// R-4: großen download streamend nach `dest`, sha512 im selben stream berechnet.
/// fortschritt via event "download-progress"; rückgabe = hex-sha512.
#[tauri::command]
pub async fn download_file(
    app: AppHandle,
    state: tauri::State<'_, CancelRegistry>,
    url: String,
    dest: String,
    download_id: String,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length();

    if let Some(parent) = Path::new(&dest).parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let mut file = tokio::fs::File::create(&dest)
        .await
        .map_err(|e| e.to_string())?;
    let mut hasher = Sha512::new();
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    let mut stream = resp.bytes_stream();

    // hilfsfunktion: ist dieser download zum abbruch markiert?
    let is_cancelled = |id: &str| -> bool {
        state.0.lock().map(|s| s.contains(id)).unwrap_or(false)
    };

    while let Some(chunk) = stream.next().await {
        if is_cancelled(&download_id) {
            drop(file);
            let _ = tokio::fs::remove_file(&dest).await; // nichts halbes hinterlassen
            if let Ok(mut s) = state.0.lock() {
                s.remove(&download_id);
            }
            return Err("cancelled".into());
        }
        let chunk = chunk.map_err(|e| e.to_string())?;
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if downloaded - last_emit >= 1_000_000 {
            last_emit = downloaded;
            let _ = app.emit(
                "download-progress",
                DownloadProgress { id: download_id.clone(), downloaded, total },
            );
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    if let Ok(mut s) = state.0.lock() {
        s.remove(&download_id); // aufräumen für re-download
    }
    let _ = app.emit(
        "download-progress",
        DownloadProgress { id: download_id.clone(), downloaded, total },
    );

    Ok(format!("{:x}", hasher.finalize()))
}

/// R-5: zur laufzeit entdeckte library/verzeichnis in den fs-scope aufnehmen.
#[tauri::command]
pub fn allow_library_scope(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let _ = app.fs_scope().allow_directory(&path, true);
    Ok(())
}

/// symlink-auflösung für steam-root-discovery.
#[tauri::command]
pub fn canonicalize_path(path: String) -> Result<String, String> {
    fs::canonicalize(&path)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

/// R-6: kanonischer pfad + (dev, ino) zur library-dedup.
#[derive(Serialize)]
pub struct PathIdentity {
    pub realpath: String,
    pub dev: String,
    pub ino: String,
}

#[tauri::command]
pub fn path_identity(path: String) -> Result<PathIdentity, String> {
    use std::os::unix::fs::MetadataExt;
    let real = fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let md = fs::metadata(&real).map_err(|e| e.to_string())?;
    Ok(PathIdentity {
        realpath: real.to_string_lossy().into_owned(),
        dev: md.dev().to_string(),
        ino: md.ino().to_string(),
    })
}
