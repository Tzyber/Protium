// rust-commands (R-1..R-6): das, was die webview nicht kann.

use std::collections::{HashMap, HashSet};
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
        // pre-check: tar-crate legt block-devices, fifos und char-devices auf
        // linux fall-back als reguläre dateien ab (mknod fehlt ohne CAP_MKNOD,
        // tar fällt auf "treat as regular file" zurück). unsere post-unpack
        // filterung (is_file() || is_dir()) würde sie dann durchlassen. der
        // tar-entry-type ist also die einzige zuverlässige quelle für die
        // entscheidung "ist das ein device?".
        //
        // erlaubt: Regular, Directory, Link (hardlinks — link-target muss
        // innerhalb des archives zeigen, sonst pfad-traversal-leck). alles
        // andere (Symlink, Block, Char, Fifo, Continuous) wird abgelehnt —
        // wenn so ein eintrag dabei ist, ist der ganze tar suspect.
        //
        // post-unpack-filter bleibt als defense-in-depth, ist aber nicht
        // mehr die primäre schutzlinie (filter iteriert nur top-level, ein
        // subdir mit bad entry würde ungeprüft durchkommen).
        {
            let f = fs::File::open(src).map_err(|e| e.to_string())?;
            let mut ar = Archive::new(GzDecoder::new(f));
            for entry in ar.entries().map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let typ = entry.header().entry_type();
                match typ {
                    tar::EntryType::Regular | tar::EntryType::Directory => {}
                    tar::EntryType::Link => {
                        // hardlink-target muss innerhalb des archives sein.
                        // ein absoluter target oder .. würde aus dem unpack-root
                        // ausbrechen — und da der post-unpack-filter nur top-level
                        // iteriert, würde so ein hardlink in einem subdir ungeprüft
                        // durchkommen. pre-check ist die einzige zuverlässige
                        // schutzlinie für hardlinks.
                        let link_name = entry.link_name().map_err(|e| e.to_string())?;
                        match link_name {
                            None => return Err("hardlink ohne link-target".into()),
                            Some(target) => {
                                if target.as_os_str().is_empty() {
                                    return Err("hardlink-target ist leer".into());
                                }
                                if target.is_absolute() {
                                    return Err(format!(
                                        "hardlink-target ist absolut: {}",
                                        target.display()
                                    ));
                                }
                                if target.components().any(|c| {
                                    matches!(c, std::path::Component::ParentDir)
                                }) {
                                    return Err(format!(
                                        "hardlink-target enthält ..: {}",
                                        target.display()
                                    ));
                                }
                            }
                        }
                    }
                    _ => {
                        return Err(format!(
                            "tar enthält unerwarteten eintragstyp: {typ:?} (path: {:?})",
                            entry.path()
                        ));
                    }
                }
            }
        }
        let f = fs::File::open(src).map_err(|e| e.to_string())?;
        let mut ar = Archive::new(GzDecoder::new(f));
        ar.unpack(&tmp).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(&tmp).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let ft = entry.file_type().map_err(|e| e.to_string())?;
            // defense-in-depth: post-unpack-filter fängt nochmal alles ab,
            // was kein file und kein dir ist (z. b. symlinks, falls tar-crate
            // sie doch mal preserved). pre-check oben ist die primäre schutzlinie.
            if ft.is_symlink() || !(ft.is_file() || ft.is_dir()) {
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
    // Substring-Match schließt absichtlich Steam-Helper wie steamwebhelper ein;
    // false-positive Blockade ist sicherer als false-negative während Writes.
    let sys = System::new_all();
    let target = name.to_lowercase();
    Ok(sys
        .processes()
        .values()
        .any(|p| p.name().to_string_lossy().to_lowercase().contains(&target)))
}

/// R-3 (S-01: validierung nach batch_dir_sizes-vorlage)
#[tauri::command]
pub fn dir_size(path: String) -> Result<u64, String> {
    sanitize_path(&path, "dir_size")?;
    let real = fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !is_safe_path(&real.to_string_lossy()) {
        return Err(format!("blocked path: {path}"));
    }
    Ok(dir_size_impl(&real))
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

/// R-3b: batch-version — sequentiell (IO-bound, kein rayon).
#[tauri::command]
pub fn batch_dir_sizes(paths: Vec<String>) -> Result<HashMap<String, u64>, String> {
    let mut map = HashMap::new();
    for p in paths {
        sanitize_path(&p, "batch_dir_sizes")?;
        let real = fs::canonicalize(&p).map_err(|e| e.to_string())?;
        if !is_safe_path(&real.to_string_lossy()) {
            return Err(format!("blocked path: {p}"));
        }
        map.insert(p, dir_size_impl(&real));
    }
    Ok(map)
}

/// löscht ein verwaistes compatdata- oder shadercache-verzeichnis.
/// leitet library + typ selbst ab (defense-in-depth: backend traut frontend nicht).
/// compatdata → trash (rename), shadercache → hard delete.
#[tauri::command]
pub fn remove_orphan_dir(app: AppHandle, path: String) -> Result<String, String> {
    let (library, canonical) = validate_and_prepare(&path)?;
    allow_library_scope_inner(app, &library)?;
    remove_orphan_dir_inner(&canonical, &library)
}

/// testbare validierungskette für den command-wrapper: sanitized input
/// (kein `..`, absolut) → symlink-guard auf roh-input → canonicalize →
/// library-derive. der symlink-guard auf roh-input ist nötig, weil
/// canonicalize symlinks folgt und der nachgelagerte symlink-check in
/// inner dann effektiv tot wäre. library wird hier einmal berechnet und
/// an inner weitergereicht (entfernt das doppelte `rfind` aus inner,
/// ohne die guard-reihenfolge zu verändern).
fn validate_and_prepare(path_str: &str) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    sanitize_path(path_str, "remove_orphan_dir")?;
    // symlink-guard auf roh-input: ein orphan-eintrag, der selbst ein symlink
    // ist, ist nie ein legitimer löschkandidat (findOrphans skippt symlinks).
    // ohne diesen check würde canonicalize dem symlink folgen, und der
    // symlink_metadata-check in inner (auf dem gefolgten pfad) wäre tot.
    let raw_meta = fs::symlink_metadata(path_str).map_err(|e| e.to_string())?;
    if raw_meta.file_type().is_symlink() {
        return Err("symlink rejected — will not recurse".into());
    }
    let canonical = fs::canonicalize(path_str).map_err(|e| e.to_string())?;
    let binding = canonical.to_string_lossy();
    let lib_str = library_of(&binding)?;
    Ok((std::path::PathBuf::from(lib_str), canonical))
}

/// reine lösch-logik: validierung (blocklist, symlink-defense-in-depth, is_dir,
/// muster, appid) + tatsächliches löschen/trash. `library` wird vom
/// command-wrapper durchgereicht (nicht erneut abgeleitet) — guard-reihenfolge
/// bleibt unverändert: erst sicherheit, dann parsing, dann delete.
fn remove_orphan_dir_inner(canonical: &Path, library: &Path) -> Result<String, String> {
    let canon_str = canonical.to_string_lossy();
    if !is_safe_path(&canon_str) {
        return Err("blocked path".into());
    }

    // symlink-guard bleibt als defense-in-depth: validate_and_prepare im
    // command-wrapper hat symlinks auf roh-input bereits abgewiesen, sodass
    // dieser check im normalen aufruf nie zuschlägt. er schützt direkte
    // inner-aufrufer (tests, zukünftige code-pfade) und kostet nichts.
    let meta = fs::symlink_metadata(canonical).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err("symlink rejected — will not recurse".into());
    }
    if !meta.is_dir() {
        return Err("not a directory".into());
    }

    let suffix = suffix_after_steamapps(&canon_str)?;

    let (typ, app_id_str) = suffix
        .split_once('/')
        .ok_or_else(|| "invalid suffix structure".to_string())?;

    if typ != "compatdata" && typ != "shadercache" {
        return Err(format!("unexpected type: {typ}"));
    }
    if app_id_str.is_empty() || !app_id_str.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("non-numeric appId: {app_id_str}"));
    }
    // defense-in-depth: das JS-seitige findOrphans filtert appId 0 bereits,
    // aber ein direkter IPC-aufruf (oder zukünftiger code-pfad) darf nicht
    // stillschweigend zum löschen / trash-renamen eines 0-verzeichnisses
    // führen. 0 ist in steam reserviert (kein spiel) und darf nie ein
    // löschkandidat sein.
    if app_id_str == "0" {
        return Err("appId 0 rejected".into());
    }

    match typ {
        "shadercache" => {
            // hard delete; trash-ordner wird NICHT angelegt (würde leer zurückbleiben)
            fs::remove_dir_all(canonical).map_err(|e| e.to_string())?;
            Ok("deleted".into())
        }
        "compatdata" => {
            let trash_dir = library.join("steamapps").join(".protium-trash");
            fs::create_dir_all(&trash_dir).map_err(|e| e.to_string())?;
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let trash_name = format!("compatdata_{app_id_str}_{ts}");
            let trash_target = trash_dir.join(&trash_name);
            fs::rename(canonical, &trash_target).map_err(|e| e.to_string())?;
            Ok(format!("trashed → {}", trash_target.display()))
        }
        _ => unreachable!(),
    }
}

/// extrahiert das library-verzeichnis (alles vor dem letzten "/steamapps/").
/// `rfind` ist sicher, weil das folgende muster-check die echte anwendung garantiert.
fn library_of(canon_str: &str) -> Result<&str, String> {
    let marker = "/steamapps/";
    let idx = canon_str
        .rfind(marker)
        .ok_or_else(|| "path does not contain /steamapps/".to_string())?;
    Ok(&canon_str[..idx])
}

/// alles nach dem letzten "/steamapps/". gibt None wenn der marker fehlt.
fn suffix_after_steamapps(canon_str: &str) -> Result<&str, String> {
    let marker = "/steamapps/";
    let idx = canon_str
        .rfind(marker)
        .ok_or_else(|| "path does not contain /steamapps/".to_string())?;
    Ok(&canon_str[idx + marker.len()..])
}

fn allow_library_scope_inner(app: AppHandle, path: &Path) -> Result<(), String> {
    if !path.is_dir() {
        return Err("library path is not a directory".into());
    }
    let real = fs::canonicalize(path).map_err(|e| format!("cannot resolve: {e}"))?;
    if !is_safe_path(&real.to_string_lossy()) {
        return Err("library path blocked".into());
    }
    let _ = app.fs_scope().allow_directory(real.to_string_lossy().as_ref(), true);
    Ok(())
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
/// auflösungen in blockierte dateisysteme verweigert (info-disclosure).
/// S-07: nutzt is_safe_path() statt eigener blocklist (konsistenz).
#[tauri::command]
pub fn canonicalize_path(path: String) -> Result<String, String> {
    sanitize_path(&path, "canonicalize")?;
    let canonical = fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let s = canonical.to_string_lossy();
    if !is_safe_path(&s) {
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

/// R-6: realpath + (dev,ino) zur library-dedup (S-02: validierung).
#[tauri::command]
pub fn path_identity(path: String) -> Result<PathIdentity, String> {
    use std::os::unix::fs::MetadataExt;
    sanitize_path(&path, "path_identity")?;
    let real = fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !is_safe_path(&real.to_string_lossy()) {
        return Err("blocked path".into());
    }
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
    use super::{canonicalize_path, dir_size, is_safe_path, path_identity, sanitize_path,
    validate_download_url};
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

    // S-01: dir_size lehnt blockierte/system-pfade ab
    #[test]
    fn dir_size_rejects_blocked_paths() {
        assert!(dir_size("/etc".into()).is_err());
        assert!(dir_size("/proc".into()).is_err());
        assert!(dir_size("/sys".into()).is_err());
        assert!(dir_size("/dev".into()).is_err());
    }

    #[test]
    fn dir_size_rejects_dotdot() {
        assert!(dir_size("/home/../etc".into()).is_err());
    }

    #[test]
    fn dir_size_accepts_normal_paths() {
        let tmp = std::env::temp_dir();
        assert!(dir_size(tmp.to_string_lossy().into_owned()).is_ok());
        assert!(dir_size("/tmp".into()).is_ok());
    }

    // T-M-01: dir_size darf symlinks nicht folgen — sonst zählt ein symlink
    // auf ein riesiges verzeichnis dessen gesamten inhalt mit (DoS / falsche anzeige).
    // fixture liegt komplett unter /tmp, kein bezug auf /mnt oder systempfade.
    #[test]
    fn dir_size_skipped_symlinks() {
        use std::os::unix::fs as unixfs;

        let mut root = std::env::temp_dir();
        root.push(format!("protium-dirsymlink-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        // echtes ziel: 5 MB große datei
        let real = root.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("big.bin"), vec![0u8; 5_000_000]).unwrap();

        // verzeichnis mit einem symlink der auf `real` zeigt
        let via = root.join("via-link");
        std::fs::create_dir_all(&via).unwrap();
        unixfs::symlink(&real, via.join("link-to-real")).unwrap();

        let res = dir_size(via.to_string_lossy().into_owned()).unwrap();
        // ohne symlink-follow: nur die paar bytes des symlinks selbst (~50 bytes).
        // MIT symlink-follow: mindestens 5 MB.
        assert!(
            res < 1000,
            "symlink wurde gefolgt — dir_size={res} (sollte < 1000 sein)"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    // S-02: path_identity lehnt blockierte pfade ab
    #[test]
    fn path_identity_rejects_blocked_paths() {
        assert!(path_identity("/etc/passwd".into()).is_err());
        assert!(path_identity("/proc/cpuinfo".into()).is_err());
    }

    #[test]
    fn path_identity_rejects_dotdot() {
        assert!(path_identity("/home/../etc/passwd".into()).is_err());
    }

    #[test]
    fn path_identity_accepts_normal_paths() {
        let tmp = std::env::temp_dir();
        let s = tmp.to_string_lossy().into_owned();
        assert!(path_identity(s).is_ok());
    }

    // S-03+S-07: canonicalize_path lehnt /etc ab (nutzt jetzt is_safe_path)
    #[test]
    fn canonicalize_rejects_etc() {
        assert!(canonicalize_path("/etc".into()).is_err());
        assert!(canonicalize_path("/etc/cron.d".into()).is_err());
    }

    // S-07: cross-check — derselbe pfad-satz den is_safe_path blockt wird abgelehnt
    #[test]
    fn canonicalize_rejects_all_blocked() {
        for blocked in &["/", "/etc", "/etc/cron.d", "/proc", "/proc/cpuinfo",
                          "/sys", "/sys/class", "/dev", "/dev/null"] {
            assert!(
                canonicalize_path(blocked.to_string()).is_err(),
                "canonicalize_path should reject {blocked}"
            );
        }
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

    // ---- remove_orphan_dir (T-H-01) ----
    // gehärtete logik via remove_orphan_dir_inner (extrahiert, AppHandle-frei)
    // + validate_and_prepare (wrapper-kette, AppHandle-frei).
    // tests nutzen temp-fixtures unter /tmp; keine berührung von /mnt o. ä.

    use super::{library_of, remove_orphan_dir_inner, validate_and_prepare};
    use std::os::unix::fs as unixfs;

    fn orphan_fixture(tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("protium-orphan-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn touch(dir: &std::path::Path) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("marker"), b"x").unwrap();
    }

    // helper: ruft inner mit korrekt abgeleiteter library auf, damit die
    // bestehenden tests nicht jeden library-pfad selbst berechnen müssen.
    fn call_inner(canonical: &std::path::Path) -> Result<String, String> {
        let lib = std::path::PathBuf::from(
            library_of(&canonical.to_string_lossy()).map_err(|e| e.to_string())?,
        );
        remove_orphan_dir_inner(canonical, &lib)
    }

    #[test]
    fn compatdata_orphan_wird_in_trash_verschoben() {
        let root = orphan_fixture("compat-trash");
        let lib = root.join("lib");
        let compat = lib.join("steamapps/compatdata/12345");
        touch(&compat);

        let canonical = std::fs::canonicalize(&compat).unwrap();
        let res = call_inner(&canonical);
        assert!(res.is_ok(), "sollte klappen: {res:?}");
        assert!(res.unwrap().contains("trashed"));
        assert!(!compat.exists(), "quelle muss weg sein");

        let trash = lib.join("steamapps/.protium-trash");
        assert!(trash.is_dir(), ".protium-trash muss angelegt sein");
        let entries: Vec<_> = std::fs::read_dir(&trash)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("compatdata_12345_")
            })
            .collect();
        assert_eq!(entries.len(), 1, "genau ein trash-eintrag für 12345");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn shadercache_orphan_wird_hard_deleted() {
        let root = orphan_fixture("shadercache-del");
        let lib = root.join("lib");
        let cache = lib.join("steamapps/shadercache/67890");
        touch(&cache);

        let canonical = std::fs::canonicalize(&cache).unwrap();
        let res = call_inner(&canonical);
        assert_eq!(res.as_deref(), Ok("deleted"));
        assert!(!cache.exists(), "shadercache muss weg sein");

        // KEIN trash-eintrag (nur compatdata wird getrasht)
        let trash = lib.join("steamapps/.protium-trash");
        assert!(
            !trash.exists(),
            "shadercache darf keinen trash-ordner anlegen"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn symlink_als_ziel_wird_abgelehnt() {
        // defense-in-depth: der command-wrapper lehnt bereits in
        // validate_and_prepare ab, aber inner soll auch direkte aufrufer
        // schützen (z. b. tests, zukünftige code-pfade). canonicalize wurde
        // hier absichtlich übersprungen, damit symlink_metadata den symlink
        // selbst sieht (sonst folgt canonicalize und der guard wäre tot).
        let root = orphan_fixture("symlink");
        let lib = root.join("lib");
        let compat_dir = lib.join("steamapps/compatdata");
        std::fs::create_dir_all(&compat_dir).unwrap();
        let target = lib.join("steamapps/compatdata/22222");
        std::fs::create_dir_all(&target).unwrap();
        let link = compat_dir.join("99999");
        unixfs::symlink(&target, &link).unwrap();

        let lib_path = std::path::PathBuf::from(library_of(&link.to_string_lossy()).unwrap());
        let res = remove_orphan_dir_inner(&link, &lib_path);
        assert!(res.is_err(), "symlink muss abgelehnt werden");
        assert!(res.as_ref().unwrap_err().contains("symlink"));
        assert!(link.exists(), "symlink selbst darf nicht angetastet werden");
        assert!(target.exists(), "ziel darf nicht angetastet werden");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pfad_ohne_steamapps_anker_wird_abgelehnt() {
        let root = orphan_fixture("no-anchor");
        let random = root.join("lib/some/other/dir");
        touch(&random);

        let canonical = std::fs::canonicalize(&random).unwrap();
        let res = call_inner(&canonical);
        assert!(res.is_err(), "ohne /steamapps/ muss abgelehnt werden");
        assert!(
            res.as_ref().unwrap_err().contains("/steamapps/"),
            "fehler soll den marker nennen: {:?}",
            res
        );
        assert!(random.exists(), "verzeichnis darf nicht angetastet werden");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn nichtnumerische_appid_wird_abgelehnt() {
        let root = orphan_fixture("nonnumeric");
        let lib = root.join("lib");
        let bad = lib.join("steamapps/compatdata/foo");
        touch(&bad);

        let canonical = std::fs::canonicalize(&bad).unwrap();
        let res = call_inner(&canonical);
        assert!(res.is_err(), "nicht-numerische appid muss abgelehnt werden");
        assert!(res.as_ref().unwrap_err().contains("non-numeric"));
        assert!(bad.exists(), "quelle darf nicht angetastet werden");

        let _ = std::fs::remove_dir_all(&root);
    }

    // defense-in-depth: JS-seitiges findOrphans filtert appId 0 bereits, aber
    // ein direkter IPC-aufruf (oder zukünftiger code-pfad) darf nicht zum
    // löschen / trash-renamen eines 0-verzeichnisses führen. 0 ist in steam
    // reserviert (kein spiel) und darf nie ein löschkandidat sein.
    #[test]
    fn appid_zero_compatdata_wird_abgelehnt() {
        let root = orphan_fixture("zero-compat");
        let lib = root.join("lib");
        let compat = lib.join("steamapps/compatdata/0");
        touch(&compat);

        let canonical = std::fs::canonicalize(&compat).unwrap();
        let res = call_inner(&canonical);
        assert!(res.is_err(), "compatdata/0 muss abgelehnt werden");
        assert!(
            res.as_ref().unwrap_err().contains("appId 0"),
            "fehlermeldung soll appId 0 nennen: {:?}",
            res
        );
        assert!(compat.exists(), "compatdata/0 darf nicht gelöscht werden");
        let trash = lib.join("steamapps/.protium-trash");
        assert!(
            !trash.exists(),
            ".protium-trash darf für appId 0 NICHT angelegt werden"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn appid_zero_shadercache_wird_abgelehnt() {
        let root = orphan_fixture("zero-shader");
        let lib = root.join("lib");
        let cache = lib.join("steamapps/shadercache/0");
        touch(&cache);

        let canonical = std::fs::canonicalize(&cache).unwrap();
        let res = call_inner(&canonical);
        assert!(res.is_err(), "shadercache/0 muss abgelehnt werden");
        assert!(
            res.as_ref().unwrap_err().contains("appId 0"),
            "fehlermeldung soll appId 0 nennen: {:?}",
            res
        );
        assert!(cache.exists(), "shadercache/0 darf nicht gelöscht werden");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn doppelter_steamapps_anker_bleibt_innerhalb_des_scopes() {
        // /tmp/.../lib/steamapps/compatdata/123/steamapps/compatdata/456
        // rfind("/steamapps/") findet den letzten anker → library wird zu
        // /tmp/.../lib/steamapps/compatdata/123. das ist INNERHALB des inputs.
        // akzeptiert: erfolgreich (in trash) ODER reject.
        // nicht akzeptabel: ein delete der outer (lib/steamapps/compatdata/123) zerstört.
        let root = orphan_fixture("double-anchor");
        let lib = root.join("lib");
        let outer = lib.join("steamapps/compatdata/123");
        let inner = outer.join("steamapps/compatdata/456");
        touch(&inner);
        // marker in outer, um zu prüfen dass outer nicht gelöscht wird
        std::fs::write(outer.join("keep"), b"important").unwrap();

        let canonical = std::fs::canonicalize(&inner).unwrap();
        let res = call_inner(&canonical);

        // outer (lib + steamapps + compatdata/123) muss IMMER noch existieren
        assert!(outer.exists(), "outer darf nicht gelöscht werden");
        assert!(outer.join("keep").exists(), "marker in outer muss bleiben");
        assert!(lib.exists(), "library-root muss bleiben");
        assert!(lib.join("steamapps").exists(), "steamapps muss bleiben");

        match res {
            Ok(msg) => {
                assert!(msg.contains("trashed"));
                assert!(!inner.exists());
            }
            Err(_) => {
                // reject ist auch ok, solange nichts zerstört wurde
                assert!(inner.exists(), "bei reject: inner muss noch da sein");
            }
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    // validate_and_prepare: testbare wrapper-kette (sanitize + symlink-guard
    // auf roh-input + canonicalize + library-derive). symlink-guard auf dem
    // nicht-kanonisierten input ist nötig, weil canonicalize symlinks folgt
    // und der nachgelagerte symlink-check in inner dann effektiv tot wäre.
    #[test]
    fn validate_and_prepare_lehnt_symlink_auf_roh_input_ab() {
        let root = orphan_fixture("raw-symlink");
        let lib = root.join("lib");
        let compat_dir = lib.join("steamapps/compatdata");
        std::fs::create_dir_all(&compat_dir).unwrap();
        let target = lib.join("steamapps/compatdata/22222");
        std::fs::create_dir_all(&target).unwrap();
        let link = compat_dir.join("99999");
        unixfs::symlink(&target, &link).unwrap();

        let res = validate_and_prepare(link.to_str().unwrap());
        assert!(res.is_err(), "symlink auf roh-input muss abgelehnt werden");
        assert!(res.as_ref().unwrap_err().contains("symlink"));
        assert!(link.exists(), "symlink selbst darf nicht angetastet werden");
        assert!(target.exists(), "ziel darf nicht angetastet werden");

        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- extract_tarball (T-H-02) ----
    // die produktion entpackt github-release-tarballs (fremde, nicht-vertrauenswürdige
    // artefakte). die hier dokumentierten beschreibungen ("symlinks werden gefiltert",
    // "devices werden gefiltert", "kein path-traversal", "kein halbes ziel bei fehler")
    // waren bisher ungetestet. tests bauen tarballs programmatisch mit dem tar-crate,
    // rufen extract_blocking direkt (kein AppHandle, kein tokio).
    //
    // befund-basis (vor tests, durch code-lesen):
    // - post-unpack-filter iteriert nur top-level-eintraege (read_dir nicht rekursiv).
    //   subdirs werden als ganzes nach dest verschoben, ohne inhalt zu prüfen.
    //   *die hier geschriebenen tests zielen auf top-level-eintraege* — der subdir-befund
    //   ist ein separater punkt (siehe report).

    use super::extract_blocking;

    fn extract_dest(tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("protium-extract-dest-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn extract_tarball<F>(tag: &str, populate: F) -> std::path::PathBuf
    where
        F: FnOnce(&mut tar::Builder<flate2::write::GzEncoder<&mut Vec<u8>>>),
    {
        let mut data = Vec::new();
        {
            let gz = flate2::write::GzEncoder::new(&mut data, flate2::Compression::default());
            let mut builder = tar::Builder::new(gz);
            populate(&mut builder);
            builder.finish().unwrap();
        }
        let mut p = std::env::temp_dir();
        p.push(format!("protium-extract-src-{tag}-{}", std::process::id()));
        std::fs::write(&p, &data).unwrap();
        p
    }

    fn extract_cleanup(tarball: &std::path::Path, dest: &std::path::Path) {
        let _ = std::fs::remove_file(tarball);
        let _ = std::fs::remove_dir_all(dest);
    }

    // helper: append_data setzt die size NICHT automatisch — der header
    // braucht sie vorher. ohne size kann das tar-archiv nicht gelesen werden
    // ("numeric field was not a number").
    fn make_data_header(path: &str, data: &[u8]) -> tar::Header {
        let mut h = tar::Header::new_gnu();
        h.set_path(path).unwrap();
        h.set_size(data.len() as u64);
        h
    }

    #[test]
    fn happy_path_extrahiert_dateien_und_verzeichnisse() {
        let tarball = extract_tarball("happy", |b| {
            b.append_data(&mut make_data_header("file.txt", b"hello"), "file.txt", &b"hello"[..])
                .unwrap();
            b.append_data(
                &mut make_data_header("subdir/nested.txt", b"world"),
                "subdir/nested.txt",
                &b"world"[..],
            )
            .unwrap();
        });
        let dest = extract_dest("happy");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap());
        assert!(res.is_ok(), "extract sollte klappen: {res:?}");
        assert!(dest.join("file.txt").is_file(), "top-level-datei fehlt");
        assert_eq!(
            std::fs::read_to_string(dest.join("file.txt")).unwrap(),
            "hello"
        );
        assert!(
            dest.join("subdir").is_dir(),
            "subdir fehlt: {:?}",
            std::fs::read_dir(&dest).unwrap().collect::<Vec<_>>()
        );
        assert!(
            dest.join("subdir/nested.txt").is_file(),
            "nested datei fehlt"
        );

        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn symlink_eintrag_wird_nicht_ins_ziel_uebernommen() {
        // dokumentation: tar mit symlink-entry wird per pre-check ABGELEHNT.
        // symlinks sind in proton-release-tarballs nie legitim, ein tar
        // mit einem symlink ist suspect. der ganze extract wird abgebrochen,
        // nichts landet im ziel.
        let tarball = extract_tarball("symlink", |b| {
            let mut header = tar::Header::new_gnu();
            header.set_size(0);
            header.set_entry_type(tar::EntryType::Symlink);
            {
                let bytes = header.as_mut_bytes();
                let path = b"evil-link\0";
                for (i, b) in path.iter().enumerate() {
                    bytes[i] = *b;
                }
                let link = b"/etc/passwd\0";
                for (i, b) in link.iter().enumerate() {
                    bytes[157 + i] = *b;
                }
            }
            header.set_cksum();
            b.append(&header, std::io::empty()).unwrap();
        });
        let dest = extract_dest("symlink");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap());
        assert!(res.is_err(), "tar mit symlink muss abgelehnt werden");
        assert!(
            std::fs::symlink_metadata(dest.join("evil-link")).is_err(),
            "evil-link darf nicht ins ziel"
        );

        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn block_device_eintrag_wird_gefiltert() {
        // dokumentation: tar mit block-device-entry wird per pre-check
        // ABGELEHNT (Err). der tar ist suspect, der ganze extract wird
        // abgebrochen. das ist strenger als selektives skippen, aber
        // sicherer: ein tar mit einem device-entry hat dort nichts zu suchen.
        let tarball = extract_tarball("blockdev", |b| {
            let mut header = tar::Header::new_gnu();
            header.set_size(0);
            header.set_entry_type(tar::EntryType::Block);
            {
                let bytes = header.as_mut_bytes();
                let path = b"blockdev\0";
                for (i, b) in path.iter().enumerate() {
                    bytes[i] = *b;
                }
            }
            header.set_cksum();
            b.append(&header, std::io::empty()).unwrap();
        });
        let dest = extract_dest("blockdev");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap());
        assert!(res.is_err(), "tar mit block-device muss abgelehnt werden");
        assert!(
            std::fs::symlink_metadata(dest.join("blockdev")).is_err(),
            "block-device darf nicht ins ziel"
        );
        // ziel-dir selbst existiert, aber KEINE inhalte aus dem tar
        let entries: Vec<String> = std::fs::read_dir(&dest)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(entries.is_empty(), "zieldir muss leer sein, ist: {entries:?}");

        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn fifo_eintrag_wird_gefiltert() {
        // siehe block_device: pre-check lehnt den tar ab, dest bleibt leer.
        let tarball = extract_tarball("fifo", |b| {
            let mut header = tar::Header::new_gnu();
            header.set_size(0);
            header.set_entry_type(tar::EntryType::Fifo);
            {
                let bytes = header.as_mut_bytes();
                let path = b"fifo\0";
                for (i, b) in path.iter().enumerate() {
                    bytes[i] = *b;
                }
            }
            header.set_cksum();
            b.append(&header, std::io::empty()).unwrap();
        });
        let dest = extract_dest("fifo");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap());
        assert!(res.is_err(), "tar mit fifo muss abgelehnt werden");
        assert!(
            std::fs::symlink_metadata(dest.join("fifo")).is_err(),
            "fifo darf nicht ins ziel"
        );
        let entries: Vec<String> = std::fs::read_dir(&dest)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(entries.is_empty(), "zieldir muss leer sein, ist: {entries:?}");

        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn path_traversal_escaped_nicht_in_tmp() {
        // KRITISCH: ein tar-eintrag mit "../"-pfad darf NIE ausserhalb von
        // dest landen. wir umgehen die `..`-validierung in `set_path` mit
        // `as_mut_bytes()` (ein angreifer könnte den tar mit einem anderen
        // tool bauen) und prüfen das beobachtbare ergebnis: /tmp/{filename}
        // darf NIE existieren.
        //
        // der pre-check lehnt den tar ab, sobald er einen eintrag mit bad
        // path findet — also nichts wird geschrieben.
        let escaped_filename = format!("protium-escape-{}.txt", std::process::id());
        let escaped_path = std::path::PathBuf::from("/tmp").join(&escaped_filename);
        let _ = std::fs::remove_file(&escaped_path);

        let malicious_path = format!("../../../../../../tmp/{escaped_filename}");
        let tarball = extract_tarball("traversal", |b| {
            let mut header = tar::Header::new_gnu();
            header.set_size(8);
            {
                let bytes = header.as_mut_bytes();
                let path = malicious_path.as_bytes();
                for (i, b) in path.iter().enumerate() {
                    if i < 100 {
                        bytes[i] = *b;
                    }
                }
                for i in path.len()..100 {
                    bytes[i] = 0;
                }
            }
            header.set_cksum();
            b.append(&header, &b"escaped!"[..]).unwrap();
        });
        let dest = extract_dest("traversal");

        let _ = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap());

        assert!(
            !escaped_path.exists(),
            "path-traversal ist gelungen: {} wurde geschrieben",
            escaped_path.display()
        );

        let _ = std::fs::remove_file(&escaped_path);
        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn hardlink_wird_wie_regulaere_datei_behandelt() {
        // dokumentation: hardlinks (EntryType::Link) sind im pre-check
        // erlaubt. ar.unpack erstellt sie als reguläre datei (oder hardlink,
        // je nach fs) im tmp-dir, und der post-unpack-filter lässt sie durch
        // (is_file() == true). sie landen im ziel — das ist das definierte
        // verhalten. tar-crate prüft, dass der link-target innerhalb des
        // archives existiert und nicht aus dem unpack-root ausbricht.
        let tarball = extract_tarball("hardlink", |b| {
            b.append_data(
                &mut make_data_header("original.txt", b"data"),
                "original.txt",
                &b"data"[..],
            )
            .unwrap();
            let mut header = tar::Header::new_gnu();
            header.set_size(0);
            header.set_entry_type(tar::EntryType::Link);
            {
                let bytes = header.as_mut_bytes();
                let path = b"hardlink-to-original\0";
                for (i, b) in path.iter().enumerate() {
                    bytes[i] = *b;
                }
                let link = b"original.txt\0";
                for (i, b) in link.iter().enumerate() {
                    bytes[157 + i] = *b;
                }
            }
            header.set_cksum();
            b.append(&header, std::io::empty()).unwrap();
        });
        let dest = extract_dest("hardlink");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap());
        assert!(res.is_ok(), "hardlink sollte extrahiert werden: {res:?}");
        assert!(dest.join("original.txt").is_file(), "original.txt fehlt");
        // hardlink landet im ziel als reguläre datei mit gleichem inhalt
        let hl = dest.join("hardlink-to-original");
        assert!(hl.is_file(), "hardlink muss als file im ziel sein");
        assert_eq!(
            std::fs::read(&hl).unwrap(),
            b"data",
            "hardlink muss inhalt von original haben"
        );

        extract_cleanup(&tarball, &dest);
    }

    // hardlink-target-validierung: ein hardlink in einem subdir auf einen
    // pfad ausserhalb des archives würde vom post-unpack-filter nicht
    // erfasst (der filter iteriert nur top-level und folgt subdirs ungeprüft).
    // der pre-check fängt das ab, weil er link-target-pfade gegen absolute
    // pfade und `..` prüft — unabhängig von der entry-position.
    #[test]
    fn hardlink_in_subdir_auf_aussenhardlink_wird_abgelehnt() {
        // konkrete lage: tar mit subdir + hardlink `subdir/inner-hardlink`
        // dessen target = `../../etc/shadow` ist. ohne pre-check würde der
        // hardlink entpackt, das subdir (inkl. hardlink) per rename ins ziel
        // wandern, und der hardlink hätte ein link auf /etc/shadow. pre-check
        // lehnt den tar ab.
        let tarball = extract_tarball("subdir-hardlink", |b| {
            // subdir entry
            let mut dir_header = tar::Header::new_gnu();
            dir_header.set_size(0);
            dir_header.set_entry_type(tar::EntryType::Directory);
            {
                let bytes = dir_header.as_mut_bytes();
                let path = b"subdir\0";
                for (i, b) in path.iter().enumerate() {
                    bytes[i] = *b;
                }
            }
            dir_header.set_cksum();
            b.append(&dir_header, std::io::empty()).unwrap();

            // hardlink im subdir, target ausserhalb archives
            let mut link_header = tar::Header::new_gnu();
            link_header.set_size(0);
            link_header.set_entry_type(tar::EntryType::Link);
            {
                let bytes = link_header.as_mut_bytes();
                let path = b"subdir/inner-hardlink\0";
                for (i, b) in path.iter().enumerate() {
                    bytes[i] = *b;
                }
                // linkname (offset 157) = "../../etc/shadow"
                let target = b"../../etc/shadow\0";
                for (i, b) in target.iter().enumerate() {
                    bytes[157 + i] = *b;
                }
            }
            link_header.set_cksum();
            b.append(&link_header, std::io::empty()).unwrap();
        });
        let dest = extract_dest("subdir-hardlink");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap());
        assert!(
            res.is_err(),
            "hardlink mit ..-target muss abgelehnt werden: {res:?}"
        );
        // weder subdir noch inner-hardlink im ziel
        assert!(
            !dest.join("subdir").exists(),
            "subdir darf nicht entpackt sein"
        );
        assert!(
            std::fs::symlink_metadata(dest.join("subdir/inner-hardlink")).is_err(),
            "inner-hardlink darf nicht entpackt sein"
        );
        // zieldir selbst existiert, aber leer
        let entries: Vec<String> = std::fs::read_dir(&dest)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(entries.is_empty(), "zieldir muss leer sein, ist: {entries:?}");

        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn fehler_beim_entpacken_laesst_kein_halbes_ziel() {
        // wir bauen einen gültigen tarball (zwei eintraege) und schneiden
        // ihn bei der hälfte ab. GzDecoder schlägt mid-stream fehl → ar.unpack
        // returnt Err → unser code verschiebt NICHTS ins ziel (rename läuft
        // erst NACH erfolgreichem unpack). das ziel muss nach dem aufruf leer sein.
        let mut data = Vec::new();
        {
            let gz = flate2::write::GzEncoder::new(&mut data, flate2::Compression::default());
            let mut builder = tar::Builder::new(gz);
            builder
                .append_data(
                    &mut make_data_header("file1.txt", b"ok"),
                    "file1.txt",
                    &b"ok"[..],
                )
                .unwrap();
            builder
                .append_data(
                    &mut make_data_header("file2.txt", b"ok2"),
                    "file2.txt",
                    &b"ok2"[..],
                )
                .unwrap();
            builder.finish().unwrap();
        }
        assert!(data.len() > 64, "tar.gz sollte nicht trivial klein sein");
        // gzip-stream in der mitte abschneiden → dekompression schlägt fehl
        let truncated = data[..data.len() / 2].to_vec();
        let mut p = std::env::temp_dir();
        p.push(format!("protium-extract-src-truncated-{}", std::process::id()));
        std::fs::write(&p, &truncated).unwrap();
        let dest = extract_dest("truncated");

        let res = extract_blocking(p.to_str().unwrap(), dest.to_str().unwrap());
        assert!(res.is_err(), "korrupter tarball muss Err liefern: {res:?}");

        // KRITISCH: kein halbes verzeichnis im ziel. (das ziel-dir selbst
        // existiert, aber es darf KEINE datei drin sein, die aus dem tar stammt.)
        let entries: Vec<String> = std::fs::read_dir(&dest)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            entries.is_empty(),
            "ziel muss leer sein, enthält aber: {entries:?}"
        );
        // auch die interne temp-dir (".protium-extract-...") darf nicht übrig sein
        for name in &entries {
            assert!(
                !name.starts_with(".protium-extract-"),
                "temp-dir wurde nicht aufgeräumt: {name}"
            );
        }

        let _ = std::fs::remove_file(&p);
        extract_cleanup(&p, &dest);
    }
}
