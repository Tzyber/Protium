// rust-commands (R-1..R-6): das, was die webview nicht kann.

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha512};
use sysinfo::System;
use tauri::{AppHandle, Emitter};
use tauri_plugin_fs::FsExt;
use tokio::io::AsyncWriteExt;

// ---- sicherheits-validierungen (webview-IPC-grenze) ----

fn sanitize_path(p: &str, label: &str) -> Result<(), String> {
    if !p.starts_with('/') {
        return Err(format!("{label}: path must be absolute"));
    }
    if p.split('/').any(|seg| seg == "..") {
        return Err(format!("{label}: path traversal rejected"));
    }
    Ok(())
}

/// canonicalisierte pfade, die NIE in den scope aufgenommen werden dürfen.
fn is_safe_path(canonical: &str) -> bool {
    let blocked: &[&str] = &["/", "/etc", "/proc", "/sys", "/dev"];
    !blocked.iter().any(|b| canonical == *b || canonical.starts_with(&format!("{b}/")))
}

fn validate_download_url(url: &str) -> Result<(), String> {
    if url.contains('@') {
        return Err("URL must not contain credentials".into());
    }
    let lower = url.to_lowercase();
    if !lower.starts_with("https://") {
        return Err("only HTTPS URLs allowed for downloads".into());
    }
    let allowed = [
        "https://objects.githubusercontent.com/",
        "https://github.com/",
    ];
    if !allowed.iter().any(|p| lower.starts_with(p)) {
        return Err("download URL domain not allowed".into());
    }
    Ok(())
}

fn random_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}", nanos)
}

/// ids laufender downloads, die abgebrochen werden sollen.
#[derive(Default)]
pub struct CancelRegistry(pub Mutex<HashSet<String>>);

/// markiert einen download zum abbruch; R-4 pollt zwischen den chunks.
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

/// R-1: .tar.gz entpacken. temp im ziel-fs (EXDEV-safe), dann rename ins ziel.
#[tauri::command]
pub async fn extract_tarball(src: String, dest: String) -> Result<(), String> {
    sanitize_path(&src, "extract source")?;
    sanitize_path(&dest, "extract destination")?;
    tokio::task::spawn_blocking(move || extract_blocking(&src, &dest))
        .await
        .map_err(|e| e.to_string())?
}

fn extract_blocking(src: &str, dest_dir: &str) -> Result<(), String> {
    use flate2::read::GzDecoder;
    use tar::Archive;

    let dest = Path::new(dest_dir);
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let canon = fs::canonicalize(dest).map_err(|e| e.to_string())?;
    if !canon.is_dir() || !is_safe_path(&canon.to_string_lossy()) {
        return Err("extract destination in blocked location".into());
    }

    let src_path = Path::new(src);
    if !src_path.is_file() {
        return Err("extract source not a regular file".into());
    }

    // unpredictable temp name (pid + nanos) → kein race auf statischen pfad
    let tag = format!(".protium-extract-{}-{}", std::process::id(), random_suffix());
    let tmp = dest.join(&tag);
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    // symlink-guard: temp-dir darf selbst kein symlink sein (TOCTOU absicherung)
    if fs::symlink_metadata(&tmp)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(true)
    {
        let _ = fs::remove_dir_all(&tmp);
        return Err("temp dir is symlink — extraction aborted".into());
    }

    let result = (|| -> Result<(), String> {
        let f = fs::File::open(src).map_err(|e| e.to_string())?;
        let mut ar = Archive::new(GzDecoder::new(f));
        ar.unpack(&tmp).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(&tmp).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let ft = entry.file_type().map_err(|e| e.to_string())?;
            if ft.is_symlink() {
                let _ = fs::remove_file(entry.path());
                continue;
            }
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

/// R-2: steam-läuft-check (INV-1a). nur "steam" als name erlaubt —
/// bewusst kein generisches process-enumeration-werkzeug für die webview.
#[tauri::command]
pub fn is_process_running(name: String) -> Result<bool, String> {
    if name.to_lowercase() != "steam" {
        return Err("process check only allowed for steam".into());
    }
    let sys = System::new_all();
    let target = name.to_lowercase();
    Ok(sys
        .processes()
        .values()
        .any(|p| p.name().to_string_lossy().to_lowercase().contains(&target)))
}

/// R-3
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

/// download-kern ohne tauri-typen (cargo-testbar). crash-fest: jeder fehlerausgang
/// (cancel, netzabbruch, schreibfehler) löscht die partielle datei vor return.
async fn download_stream(
    url: &str,
    dest: &str,
    is_cancelled: impl Fn() -> bool,
    mut on_progress: impl FnMut(u64, Option<u64>),
) -> Result<String, String> {
    let result: Result<String, String> = async {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
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

    // partielle datei bei fehler weg (vor return)
    if result.is_err() {
        let _ = tokio::fs::remove_file(dest).await;
    }
    result
}

/// R-4: tauri-wrapper um download_stream — cancel-registry + fortschritt (throttled ~1 MB).
/// validiert URL (domain + https) und dest-pfad vor dem start.
#[tauri::command]
pub async fn download_file(
    app: AppHandle,
    state: tauri::State<'_, CancelRegistry>,
    url: String,
    dest: String,
    download_id: String,
) -> Result<String, String> {
    validate_download_url(&url)?;
    // dest: nur absolute pfade, kein .., elternverzeichnis nicht in blocked locations
    sanitize_path(&dest, "download dest")?;
    if let Some(parent) = Path::new(&dest).parent() {
        if parent.as_os_str().is_empty() {
            return Err("invalid download dest".into());
        }
        // falls das elternverzeichnis bereits existiert: canonicalisieren und prüfen
        if parent.exists() {
            let canon =
                fs::canonicalize(parent).map_err(|e| format!("download dest parent: {e}"))?;
            if !is_safe_path(&canon.to_string_lossy()) {
                return Err("download dest in blocked location".into());
            }
        }
    }

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
        s.remove(&download_id); // aufräumen für re-download
    }
    result
}

/// R-5: verzeichnis zur laufzeit in den fs-scope aufnehmen.
/// zwingend: canonicalize + sicherheitscheck — keine systemverzeichnisse.
#[tauri::command]
pub fn allow_library_scope(app: tauri::AppHandle, path: String) -> Result<(), String> {
    sanitize_path(&path, "library path")?;
    let real = fs::canonicalize(&path).map_err(|e| format!("cannot resolve library path: {e}"))?;
    if !real.is_dir() {
        return Err("library path is not a directory".into());
    }
    if !is_safe_path(&real.to_string_lossy()) {
        return Err("library path in blocked system directory rejected".into());
    }
    let _ = app.fs_scope().allow_directory(real.to_string_lossy().as_ref(), true);
    Ok(())
}

/// symlink-auflösung (steam-root-discovery). `..` im input abgelehnt,
/// auflösungen nach /proc /sys /dev verweigert (info-disclosure).
/// blockt sowohl das verzeichnis selbst als auch inhalte darunter.
#[tauri::command]
pub fn canonicalize_path(path: String) -> Result<String, String> {
    sanitize_path(&path, "canonicalize")?;
    let canonical = fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let s = canonical.to_string_lossy();
    if s == "/proc" || s.starts_with("/proc/")
        || s == "/sys" || s.starts_with("/sys/")
        || s == "/dev" || s.starts_with("/dev/")
    {
        return Err("path resolution in blocked filesystem".into());
    }
    Ok(s.into_owned())
}

/// R-6: realpath + (dev,ino) zur library-dedup.
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
    use super::{is_safe_path, sanitize_path, validate_download_url};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;

    // ---- sicherheits-validierung ----

    #[test]
    fn sanitize_rejects_relative() {
        assert!(sanitize_path("foo/bar", "test").is_err());
        assert!(sanitize_path("./foo", "test").is_err());
    }

    #[test]
    fn sanitize_rejects_dotdot() {
        assert!(sanitize_path("/foo/../bar", "test").is_err());
        assert!(sanitize_path("/../etc", "test").is_err());
        assert!(sanitize_path("/home/user/../../../etc", "test").is_err());
    }

    #[test]
    fn sanitize_accepts_normal() {
        assert!(sanitize_path("/home/user/.steam", "test").is_ok());
        assert!(sanitize_path("/mnt/games", "test").is_ok());
        assert!(sanitize_path("/run/media/user/SteamLibrary", "test").is_ok());
    }

    #[test]
    fn safe_path_blocks_system_dirs() {
        assert!(!is_safe_path("/"));
        assert!(!is_safe_path("/etc"));
        assert!(!is_safe_path("/etc/cron.d"));
        assert!(!is_safe_path("/proc"));
        assert!(!is_safe_path("/proc/cpuinfo"));
        assert!(!is_safe_path("/sys"));
        assert!(!is_safe_path("/sys/class"));
        assert!(!is_safe_path("/dev"));
        assert!(!is_safe_path("/dev/null"));
    }

    #[test]
    fn safe_path_allows_normal_dirs() {
        assert!(is_safe_path("/home/user/.steam"));
        assert!(is_safe_path("/mnt/games"));
        assert!(is_safe_path("/run/media/user/lib"));
        assert!(is_safe_path("/tmp/build"));
    }

    #[test]
    fn download_url_rejects_http() {
        assert!(validate_download_url("http://objects.githubusercontent.com/file.tar.gz").is_err());
        assert!(validate_download_url("HTTP://example.com/file").is_err());
    }

    #[test]
    fn download_url_rejects_credentials() {
        assert!(validate_download_url("https://user:pass@objects.githubusercontent.com/f").is_err());
        assert!(validate_download_url("https://objects.githubusercontent.com@evil.com/f").is_err());
    }

    #[test]
    fn download_url_rejects_other_domains() {
        assert!(validate_download_url("https://evil.com/payload.tar.gz").is_err());
        assert!(validate_download_url("https://objects.githubusercontent.com.evil.com/f").is_err());
    }

    #[test]
    fn download_url_allows_github_domains() {
        assert!(validate_download_url("https://objects.githubusercontent.com/github-production-release-asset-2e/f.tar.gz").is_ok());
        assert!(validate_download_url("https://github.com/GloriousEggroll/proton-ge-custom/releases/download/f.tar.gz").is_ok());
    }

    // ---- download-stream (bestehend) ----

    /// HTTP-stub: kündigt `announce` bytes an, sendet nur `send`.
    /// send < announce simuliert einen netzabbruch (vorzeitiger EOF).
    fn serve_once(announce: usize, send: usize) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf); // request ignorieren
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
