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

/// pure download-kernlogik ohne tauri-typen → per cargo-test verifizierbar.
/// streamt nach `dest`, sha512 im stream, pollt `is_cancelled` zwischen chunks,
/// meldet fortschritt via `on_progress`. crash-fest: JEDER fehlerausgang
/// (cancel, netzwerkabbruch, schreibfehler) löscht die partielle datei vor return.
async fn download_stream(
    url: &str,
    dest: &str,
    is_cancelled: impl Fn() -> bool,
    mut on_progress: impl FnMut(u64, Option<u64>),
) -> Result<String, String> {
    let result: Result<String, String> = async {
        let client = reqwest::Client::builder()
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let total = resp.content_length();

        if let Some(parent) = Path::new(dest).parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let mut file = tokio::fs::File::create(dest)
            .await
            .map_err(|e| e.to_string())?;
        let mut hasher = Sha512::new();
        let mut downloaded: u64 = 0;
        let mut stream = resp.bytes_stream();

        while let Some(chunk) = stream.next().await {
            if is_cancelled() {
                return Err("cancelled".into());
            }
            let chunk = chunk.map_err(|e| e.to_string())?; // netzwerkabbruch landet hier
            hasher.update(&chunk);
            file.write_all(&chunk).await.map_err(|e| e.to_string())?; // schreibfehler hier
            downloaded += chunk.len() as u64;
            on_progress(downloaded, total);
        }
        file.flush().await.map_err(|e| e.to_string())?;
        Ok(format!("{:x}", hasher.finalize()))
    }
    .await;

    // crash-fest: partielle datei bei jedem fehler weg, bevor zurückgekehrt wird
    if result.is_err() {
        let _ = tokio::fs::remove_file(dest).await;
    }
    result
}

/// R-4: tauri-wrapper um `download_stream`. verbindet die cancel-registry (per id)
/// und emittet fortschritt (throttled ~1 MB). registry-eintrag wird immer entfernt.
#[tauri::command]
pub async fn download_file(
    app: AppHandle,
    state: tauri::State<'_, CancelRegistry>,
    url: String,
    dest: String,
    download_id: String,
) -> Result<String, String> {
    let id = download_id.clone();
    let mut last_emit: u64 = 0;

    let result = download_stream(
        &url,
        &dest,
        || state.0.lock().map(|s| s.contains(&id)).unwrap_or(false),
        |downloaded, total| {
            let done = total.map(|t| downloaded >= t).unwrap_or(false);
            if downloaded - last_emit >= 1_000_000 || done {
                last_emit = downloaded;
                let _ = app.emit(
                    "download-progress",
                    DownloadProgress { id: download_id.clone(), downloaded, total },
                );
            }
        },
    )
    .await;

    if let Ok(mut s) = state.0.lock() {
        s.remove(&download_id); // registry immer aufräumen (re-download möglich)
    }
    result
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

#[cfg(test)]
mod tests {
    use super::download_stream;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;

    /// einmal-HTTP-server: kündigt `announce` bytes im Content-Length an, sendet aber
    /// nur `send`. announce == send → sauberer download; send < announce → verbindung
    /// bricht vorzeitig ab (netzwerkabbruch-simulation). gibt die url zurück.
    fn serve_once(announce: usize, send: usize) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf); // request lesen, ignorieren
                let header =
                    format!("HTTP/1.1 200 OK\r\nContent-Length: {announce}\r\n\r\n");
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&vec![0xABu8; send]);
                // bei send < announce: stream wird hier gedroppt → client sieht EOF zu früh
            }
        });
        format!("http://{addr}/")
    }

    fn tmp(tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("protium-dltest-{tag}-{}", std::process::id()));
        p.push("file.bin");
        p
    }

    #[tokio::test]
    async fn erfolg_berechnet_hash_und_behaelt_datei() {
        let dest = tmp("ok");
        let url = serve_once(32, 32);
        let cancel = AtomicBool::new(false);
        let res = download_stream(
            &url,
            dest.to_str().unwrap(),
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
        )
        .await;
        assert!(res.is_ok(), "sollte erfolgreich sein: {res:?}");
        assert_eq!(res.unwrap().len(), 128); // sha512 hex = 128 zeichen
        assert!(dest.exists(), "erfolgsfall: datei muss bleiben");
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    #[tokio::test]
    async fn netzabbruch_raeumt_partielle_datei_auf() {
        let dest = tmp("net");
        let url = serve_once(1_000_000, 4096); // 1MB angekündigt, nur 4KB gesendet
        let cancel = AtomicBool::new(false);
        let res = download_stream(
            &url,
            dest.to_str().unwrap(),
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
        )
        .await;
        assert!(res.is_err(), "vorzeitiger EOF muss fehler sein");
        assert!(!dest.exists(), "partielle datei muss weg sein");
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    #[tokio::test]
    async fn cancel_stoppt_und_raeumt_auf() {
        let dest = tmp("cancel");
        let url = serve_once(32, 32);
        let cancel = AtomicBool::new(true); // sofort gesetzt → bricht beim ersten chunk ab
        let res = download_stream(
            &url,
            dest.to_str().unwrap(),
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
        )
        .await;
        assert_eq!(res.unwrap_err(), "cancelled");
        assert!(!dest.exists(), "abbruch: keine datei zurücklassen");
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }
}
