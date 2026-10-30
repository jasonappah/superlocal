#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpStream},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, RwLock,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::webview::{Cookie, NewWindowResponse};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Readiness {
    version: u8,
    pid: u32,
    api_port: u16,
    build: String,
    instance_id: String,
    mode: String,
}

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        drop(self.0.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(12);
        loop {
            match self.0.try_wait() {
                Ok(Some(_)) => return,
                Err(_) => break,
                _ => {}
            }
            if Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct State {
    child: Mutex<Option<OwnedChild>>,
    origin: Arc<RwLock<Option<tauri::Url>>>,
    quitting: AtomicBool,
    shutdown_complete: AtomicBool,
    /// Manual recovery request from the Mail menu.
    retry: AtomicBool,
    /// True while the supervisor is between host generations.
    disconnected: AtomicBool,
}

/// Progress identity shared with the host readiness frame; not a credential.
const BUILD_ID: &str = "desktop-1";

/// Blocks mail interaction while the owned host is restarting, without unmounting
/// the renderer (so a durable draft and the current view stay in the document).
const SHOW_DISCONNECTED: &str = r#"(() => {
  if (document.getElementById('superlocal-desktop-recovery')) return;
  try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (error) {}
  const overlay = document.createElement('div');
  overlay.id = 'superlocal-desktop-recovery';
  overlay.setAttribute('role', 'alert');
  overlay.setAttribute('aria-live', 'assertive');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(16,16,18,.55);font:15px -apple-system,system-ui,sans-serif;color:#f4f2ef;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)';
  overlay.innerHTML = '<div style="max-width:26rem;padding:1.5rem 1.6rem;border-radius:.9rem;background:#1b1b1e;box-shadow:0 1.2rem 4rem rgba(0,0,0,.5)"><h1 style="margin:0 0 .5rem;font-size:1rem;font-weight:600">Reconnecting to your mail</h1><p style="margin:0;line-height:1.55;color:#b7b3ad">Superlocal lost its local mail host and is restarting it. Changes are paused until it reconnects. If this stays up, choose Retry Connection from the Mail menu.</p></div>';
  document.documentElement.appendChild(overlay);
  try { document.body.inert = true; } catch (error) {}
})()"#;

const CLEAR_DISCONNECTED: &str = r#"(() => {
  const overlay = document.getElementById('superlocal-desktop-recovery');
  if (overlay) overlay.remove();
  try { document.body.inert = false; } catch (error) {}
})()"#;

fn private_file(path: &Path) -> Result<(), String> {
    let meta =
        fs::symlink_metadata(path).map_err(|_| "An existing profile identity file is missing")?;
    if !meta.is_file()
        || meta.file_type().is_symlink()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || meta.nlink() != 1
    {
        return Err("Profile identity files must be owner-only regular files".into());
    }
    Ok(())
}

// Verify the established connection itself, not merely a listener at the same
// port. Once established, a replacement listener cannot acquire this TCP tuple.
fn verify_owned_connection(child: &mut Child, stream: &TcpStream, port: u16) -> Result<(), String> {
    let local = stream
        .local_addr()
        .map_err(|_| "Cannot inspect bootstrap connection")?;
    if local.ip() != Ipv4Addr::LOCALHOST
        || stream
            .peer_addr()
            .map_err(|_| "Cannot inspect bootstrap peer")?
            != SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into()
    {
        return Err("Invalid bootstrap socket".into());
    }
    let expected = format!("n127.0.0.1:{port}->127.0.0.1:{}", local.port());
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if child
            .try_wait()
            .map_err(|_| "Cannot inspect host process")?
            .is_some()
        {
            return Err("Host exited before bootstrap".into());
        }
        let output = Command::new("/usr/sbin/lsof")
            .args([
                "-nP",
                "-a",
                "-p",
                &child.id().to_string(),
                "-iTCP",
                "-sTCP:ESTABLISHED",
                "-Fn",
            ])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|_| "Cannot verify bootstrap socket owner")?;
        if output.status.success()
            && output.stdout.len() <= 65536
            && String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(|line| line == expected)
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("Bootstrap connection is not owned by the host child".into());
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn bootstrap_cookie(child: &mut Child, port: u16, token: &str) -> Result<String, String> {
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let mut stream = TcpStream::connect_timeout(&address.into(), Duration::from_secs(5))
        .map_err(|_| "Cannot connect to host")?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| "Cannot set socket timeout")?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| "Cannot set socket timeout")?;
    verify_owned_connection(child, &stream, port)?;
    let body = serde_json::json!({"token":token}).to_string();
    write!(stream, "POST /host/desktop/bootstrap HTTP/1.1\r\nHost: localhost:{port}\r\nOrigin: http://localhost:{port}\r\nX-Superlocal: 1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).map_err(|_| "Host bootstrap failed")?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    (&mut reader)
        .take(8193)
        .read_line(&mut line)
        .map_err(|_| "Invalid bootstrap response")?;
    if !line.starts_with("HTTP/1.1 204 ") || !line.ends_with("\r\n") {
        return Err("Host rejected bootstrap".into());
    }
    let mut cookie = None;
    let mut total = line.len();
    loop {
        line.clear();
        (&mut reader)
            .take(8193)
            .read_line(&mut line)
            .map_err(|_| "Invalid bootstrap response")?;
        total += line.len();
        if total > 16384 || !line.ends_with("\r\n") {
            return Err("Invalid bootstrap response".into());
        }
        if line == "\r\n" {
            break;
        }
        let (name, value) = line
            .trim_end_matches("\r\n")
            .split_once(':')
            .ok_or("Invalid bootstrap header")?;
        if name.eq_ignore_ascii_case("set-cookie") {
            if cookie.is_some() {
                return Err("Multiple host sessions".into());
            }
            cookie = Some(value.trim().to_string());
        }
    }
    cookie.ok_or_else(|| "Host session missing".into())
}

fn private_dir(path: &Path) -> Result<(), String> {
    if !path.exists() {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .map_err(|_| "Cannot create private desktop profile")?;
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| "Cannot inspect desktop profile")?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.mode() & 0o077 != 0
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err("Desktop profile must be a private owner-only directory".into());
    }
    Ok(())
}

fn open_external(url: &tauri::Url) {
    // Sender pages and confirmation mail are the only things a local mail client
    // hands to the operating system. Everything else stays inside the app.
    let web = matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none();
    let mail = url.scheme() == "mailto"
        && url.host_str().is_none()
        && !url.path().is_empty()
        && url.path().len() <= 320
        && url.path().contains('@')
        && !url.path().chars().any(|c| c.is_whitespace() || c.is_control());
    if web || mail {
        let _ = Command::new("/usr/bin/open")
            .arg(url.as_str())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}
fn same_origin(url: &tauri::Url, origin: &tauri::Url) -> bool {
    url.scheme() == origin.scheme()
        && url.host_str() == origin.host_str()
        && url.port_or_known_default() == origin.port_or_known_default()
        && url.username().is_empty()
        && url.password().is_none()
}

/// One-time owner selection of an existing Superlocal configuration. Stored as a
/// private pointer so Finder launches adopt the same profile without an env var.
fn adoption_pointer(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|_| "Cannot locate application configuration")?;
    let pointer = directory.join("existing-config");
    match fs::symlink_metadata(&pointer) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Cannot read the existing-configuration pointer".into()),
        Ok(meta) => {
            if !meta.is_file()
                || meta.file_type().is_symlink()
                || meta.uid() != unsafe { libc::geteuid() }
                || meta.mode() & 0o077 != 0
                || meta.len() > 4096
            {
                return Err("The existing-configuration pointer must be a private owner-only file".into());
            }
            let value = fs::read_to_string(&pointer)
                .map_err(|_| "Cannot read the existing-configuration pointer")?;
            let value = value.trim_end_matches(['\n', '\r']);
            if value.is_empty() || value.contains('\n') || !Path::new(value).is_absolute() {
                return Err("The existing-configuration pointer must name one absolute path".into());
            }
            Ok(Some(PathBuf::from(value)))
        }
    }
}

fn start(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<OwnedChild, String> {
    let adoption = match std::env::var_os("SUPERLOCAL_DESKTOP_ADOPT_CONFIG") {
        Some(value) => Some(value),
        None => adoption_pointer(app)?.map(PathBuf::into_os_string),
    };
    if adoption.is_some() && std::env::var_os("SUPERLOCAL_DESKTOP_PROFILE").is_some() {
        return Err("Choose either a fresh profile or an existing configuration".into());
    }
    let fresh_profile = match std::env::var_os("SUPERLOCAL_DESKTOP_PROFILE") {
        Some(path) => {
            let path = PathBuf::from(path);
            if !path.is_absolute() {
                return Err("Profile path must be absolute".into());
            }
            path
        }
        None => app
            .path()
            .app_data_dir()
            .map_err(|_| "Cannot locate application data")?
            .join("profile"),
    };
    let (profile, config, home, data_override) = if let Some(path) = adoption {
        let config = PathBuf::from(path);
        if !config.is_absolute() {
            return Err("Adopted configuration path must be absolute".into());
        }
        private_file(&config)?;
        let config =
            fs::canonicalize(config).map_err(|_| "Cannot resolve adopted configuration")?;
        let profile = config
            .parent()
            .ok_or("Invalid adopted configuration")?
            .to_path_buf();
        let home =
            PathBuf::from(std::env::var_os("HOME").ok_or("Cannot locate existing user data")?);
        if !home.is_absolute() {
            return Err("User home must be absolute".into());
        }
        let value: serde_json::Value = serde_json::from_slice(
            &fs::read(&config).map_err(|_| "Cannot read adopted configuration")?,
        )
        .map_err(|_| "Invalid adopted configuration")?;
        let instance = value["instanceId"]
            .as_str()
            .ok_or("Missing profile identity")?;
        if instance.len() != 36 || !instance.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
            return Err("Invalid profile identity".into());
        }
        let mode = value["mode"]
            .as_str()
            .filter(|m| *m == "mock" || *m == "real")
            .ok_or("Invalid profile mode")?;
        let data = match value.get("dataDir") {
            Some(serde_json::Value::Null) => home
                .join("Library/Application Support/superlocal")
                .join(instance),
            Some(serde_json::Value::String(path)) if !path.is_empty() => profile.join(path),
            _ => return Err("Invalid adopted data path".into()),
        };
        let data = fs::canonicalize(data).map_err(|_| "Existing profile data is missing")?;
        let mode_dir = data.join(mode);
        let meta = fs::symlink_metadata(&mode_dir).map_err(|_| "Existing mode data is missing")?;
        if !meta.is_dir()
            || meta.file_type().is_symlink()
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o077 != 0
        {
            return Err("Existing mode data must be a private directory".into());
        }
        private_file(&mode_dir.join("runtime-secrets.json"))?;
        private_file(&mode_dir.join("host.sqlite"))?;
        if mode == "mock" {
            private_file(&mode_dir.join("mock-inbox.sqlite"))?;
            private_file(&mode_dir.join("mock-upstream.sqlite"))?;
        } else {
            private_file(&mode_dir.join("inbox.sqlite"))?;
        }
        (profile, config, home, None)
    } else {
        private_dir(&fresh_profile)?;
        let config = fresh_profile.join("config.json");
        let data = fresh_profile.join("data");
        if !config.exists() && data.exists() {
            return Err("Profile configuration is missing; existing data was not changed".into());
        }
        if config.exists() && !data.exists() {
            return Err("Profile data is missing; the existing identity was not recreated".into());
        }
        (fresh_profile.clone(), config, fresh_profile, Some(data))
    };
    let resources = app
        .path()
        .resource_dir()
        .map_err(|_| "Cannot locate application resources")?
        .join("resources");
    let host = resources.join("superlocal-host");
    let assets = resources.join("web");
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(|_| "Cannot generate bootstrap secret")?;
    let token = URL_SAFE_NO_PAD.encode(random);
    let mut command = Command::new(host);
    command
        .current_dir(&profile)
        .env_clear()
        .env("HOME", &home)
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("SUPERLOCAL_DESKTOP", "1")
        .env("SUPERLOCAL_DESKTOP_SUPERVISED", "1")
        .env("SUPERLOCAL_CONFIG", &config)
        .env("SUPERLOCAL_DESKTOP_ASSETS", assets)
        .env("SUPERLOCAL_BUILD_ID", BUILD_ID)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(data) = data_override {
        command.env("SUPERLOCAL_DATA_DIR", data);
    }
    let mut child = OwnedChild(command.spawn().map_err(|_| "Cannot start desktop host")?);
    let mut stdout = BufReader::new(child.0.stdout.take().ok_or("Host stdout unavailable")?);
    let mut stderr = child.0.stderr.take().ok_or("Host stderr unavailable")?;
    // Keep a bounded private log so a failed host can be diagnosed from the app
    // bundle instead of only from a terminal session.
    let log_path = app.path().app_log_dir().ok().map(|dir| dir.join("host.log"));
    thread::spawn(move || {
        let mut file = log_path.as_ref().and_then(|path| {
            fs::create_dir_all(path.parent()?).ok()?;
            let mut options = fs::OpenOptions::new();
            options.create(true).write(true).truncate(true).mode(0o600);
            options.open(path).ok()
        });
        let mut reader = BufReader::new(&mut stderr);
        let mut line = Vec::new();
        let mut written = 0usize;
        loop {
            line.clear();
            match reader.by_ref().take(8192).read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let _ = std::io::stderr().write_all(&line);
                    if let Some(file) = file.as_mut() {
                        if written < 1_048_576 {
                            written += line.len();
                            let _ = file.write_all(&line);
                        }
                    }
                }
            }
        }
    });
    let stdin = child.0.stdin.as_mut().ok_or("Host stdin unavailable")?;
    writeln!(
        stdin,
        "{}",
        serde_json::json!({"version":1,"bootstrapToken":token})
    )
    .map_err(|_| "Cannot send bootstrap")?;
    stdin.flush().map_err(|_| "Cannot flush bootstrap")?;
    let (tx, rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut line = String::new();
        let result = (&mut stdout).take(4097).read_line(&mut line).map(|_| line);
        let _ = tx.send(result);
        let _ = std::io::copy(&mut stdout, &mut std::io::sink());
    });
    let line = rx
        .recv_timeout(Duration::from_secs(35))
        .map_err(|_| "Host readiness timed out")?
        .map_err(|_| "Host readiness failed")?;
    if line.len() > 4096 || !line.ends_with('\n') {
        return Err("Invalid host readiness".into());
    }
    let ready: Readiness = serde_json::from_str(&line).map_err(|_| "Invalid host readiness")?;
    let config_data: serde_json::Value =
        serde_json::from_slice(&fs::read(&config).map_err(|_| "Cannot read profile identity")?)
            .map_err(|_| "Invalid profile identity")?;
    if ready.version != 1
        || ready.pid != child.0.id()
        || ready.api_port == 0
        || config_data["backend"]["port"].as_u64() != Some(ready.api_port as u64)
        || ready.build != BUILD_ID
        || config_data["instanceId"].as_str() != Some(&ready.instance_id)
        || config_data["mode"].as_str() != Some(&ready.mode)
        || !matches!(ready.mode.as_str(), "mock" | "real")
    {
        return Err("Host identity did not match its profile".into());
    }
    let origin: tauri::Url = format!("http://localhost:{}", ready.api_port)
        .parse()
        .map_err(|_| "Invalid host origin")?;
    let header = bootstrap_cookie(&mut child.0, ready.api_port, &token)?;
    let parsed = Cookie::parse(header).map_err(|_| "Invalid host session")?;
    let expected_name = format!(
        "superlocal_{}_{}",
        ready.instance_id.replace('-', ""),
        ready.mode
    );
    if parsed.name() != expected_name
        || parsed.value().len() != 43
        || !parsed
            .value()
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || parsed.http_only() != Some(true)
        || parsed.path() != Some("/")
    {
        return Err("Invalid host session".into());
    }
    let cookie = Cookie::build((parsed.name().to_string(), parsed.value().to_string()))
        .domain("localhost")
        .path("/")
        .http_only(true)
        .build();
    window
        .set_cookie(cookie)
        .map_err(|_| "Cannot install WebView session")?;
    *app.state::<State>()
        .origin
        .write()
        .map_err(|_| "Navigation state unavailable")? = Some(origin.clone());
    window
        .navigate(origin)
        .map_err(|_| "Cannot open local mail")?;
    Ok(child)
}

fn install_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
    let retry = MenuItem::with_id(
        app,
        "retry-host",
        "Retry Connection",
        true,
        Some("CmdOrCtrl+R"),
    )?;
    let mail = Submenu::with_items(app, "Mail", true, &[&retry])?;
    let application = Submenu::with_items(
        app,
        "Superlocal",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    app.set_menu(Menu::with_items(
        app,
        &[&application, &edit, &mail],
    )?)?;
    Ok(())
}

/// Single owner of the host lifecycle: initial start, crash detection and restart.
/// Mail interaction is blocked (inert renderer) while no host is serving it.
fn supervise(handle: tauri::AppHandle, window: tauri::WebviewWindow) {
    let state = handle.state::<State>();
    let mut failures = 0u32;
    let mut ever_connected = false;
    loop {
        if state.quitting.load(Ordering::SeqCst) {
            return;
        }
        if state.retry.swap(false, Ordering::SeqCst) {
            let dead = match state.child.lock() {
                Ok(mut guard) => guard.take(),
                Err(_) => None,
            };
            drop(dead);
        }
        let running = match state.child.lock() {
            Ok(mut guard) => match guard.as_mut() {
                Some(child) => match child.0.try_wait() {
                    Ok(None) => true,
                    _ => {
                        guard.take();
                        false
                    }
                },
                None => false,
            },
            Err(_) => false,
        };
        if running {
            failures = 0;
            thread::sleep(Duration::from_millis(400));
            continue;
        }
        if ever_connected {
            state.disconnected.store(true, Ordering::SeqCst);
            let _ = window.eval(SHOW_DISCONNECTED);
        }
        // Automatic retries are bounded; after that recovery is an explicit menu action.
        if failures >= 5 {
            thread::sleep(Duration::from_millis(400));
            continue;
        }
        if failures > 0 || ever_connected {
            let pause = Duration::from_millis(700 * u64::from(1u32 << failures.min(3)));
            let deadline = Instant::now() + pause;
            while Instant::now() < deadline {
                if state.quitting.load(Ordering::SeqCst) {
                    return;
                }
                if state.retry.swap(false, Ordering::SeqCst) {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
            if state.quitting.load(Ordering::SeqCst) {
                return;
            }
        }
        match start(&handle, &window) {
            Ok(child) => {
                let quitting = state.quitting.load(Ordering::SeqCst);
                if quitting {
                    drop(child);
                    return;
                }
                match state.child.lock() {
                    Ok(mut guard) => *guard = Some(child),
                    Err(_) => return,
                }
                failures = 0;
                if ever_connected {
                    state.disconnected.store(false, Ordering::SeqCst);
                    let _ = window.eval(CLEAR_DISCONNECTED);
                    // A restarted host has a new in-memory session; reload with the
                    // new cookie. Durable drafts and receipts survive the reload.
                    let _ = window.eval("window.location.reload()");
                }
                ever_connected = true;
            }
            Err(error) => {
                eprintln!("Desktop host unavailable: {error}");
                failures = failures.saturating_add(1);
            }
        }
    }
}

fn main() {
    let origin = Arc::new(RwLock::new(None::<tauri::Url>));
    let nav_origin = origin.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(State {
            child: Mutex::new(None),
            origin,
            quitting: AtomicBool::new(false),
            shutdown_complete: AtomicBool::new(false),
            retry: AtomicBool::new(false),
            disconnected: AtomicBool::new(false),
        })
        .on_menu_event(|app, event| {
            if event.id() == "retry-host" {
                app.state::<State>().retry.store(true, Ordering::SeqCst);
            }
        })
        .setup(move |app| {
            install_menu(app.handle())?;
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Superlocal")
                    .inner_size(1180.0, 800.0)
                    .on_navigation(move |url| {
                        if let Ok(guard) = nav_origin.read() {
                            if let Some(origin) = guard.as_ref() {
                                if same_origin(url, origin) {
                                    return true;
                                }
                            } else if url.scheme() == "tauri" {
                                return true;
                            }
                        }
                        open_external(url);
                        false
                    })
                    .on_new_window(|url, _| {
                        open_external(&url);
                        NewWindowResponse::Deny
                    })
                    .build()?;
            let handle = app.handle().clone();
            thread::spawn(move || supervise(handle, window));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build desktop app");
    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            };
        }
        RunEvent::ExitRequested { api, .. } => {
            let state = app.state::<State>();
            if state.shutdown_complete.load(Ordering::SeqCst) {
                return;
            }
            api.prevent_exit();
            if !state.quitting.swap(true, Ordering::SeqCst) {
                let handle = app.clone();
                thread::spawn(move || {
                    let state = handle.state::<State>();
                    if let Ok(mut child) = state.child.lock() {
                        drop(child.take());
                    }
                    state.shutdown_complete.store(true, Ordering::SeqCst);
                    handle.exit(0);
                });
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_listener_never_receives_bootstrap() {
        let script = "import socket,sys; s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); print(s.getsockname()[1],flush=True); c,_=s.accept(); c.settimeout(8); print(len(c.recv(4096)),flush=True)";
        let mut impostor = Command::new("/usr/bin/python3")
            .args(["-u", "-c", script])
            .stdout(Stdio::piped())
            .spawn()
            .expect("impostor server");
        let mut output = BufReader::new(impostor.stdout.take().unwrap());
        let mut port = String::new();
        output.read_line(&mut port).unwrap();
        let mut owner = Command::new("/bin/sleep").arg("10").spawn().unwrap();
        let result = bootstrap_cookie(&mut owner, port.trim().parse().unwrap(), "fictional-secret");
        assert!(result.is_err());
        let mut received = String::new();
        output.read_line(&mut received).unwrap();
        assert_eq!(received.trim(), "0");
        let _ = owner.kill();
        let _ = owner.wait();
        assert!(impostor.wait().unwrap().success());
    }

    #[test]
    fn port_replacement_after_owner_exit_gets_no_secret() {
        let original_script = "import socket,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(('127.0.0.1',0)); s.listen(); print(s.getsockname()[1],flush=True); time.sleep(30)";
        let mut original = Command::new("/usr/bin/python3")
            .args(["-u", "-c", original_script])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(original.stdout.take().unwrap());
        let mut port = String::new();
        stdout.read_line(&mut port).unwrap();
        original.kill().unwrap();
        original.wait().unwrap();
        let replacement_script = "import socket,sys; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(('127.0.0.1',int(sys.argv[1]))); s.listen(); print('ready',flush=True); c,_=s.accept(); c.settimeout(8); print(len(c.recv(4096)),flush=True)";
        let mut replacement = Command::new("/usr/bin/python3")
            .args(["-u", "-c", replacement_script, port.trim()])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(replacement.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "ready");
        assert!(bootstrap_cookie(
            &mut original,
            port.trim().parse().unwrap(),
            "fictional-secret"
        )
        .is_err());
        line.clear();
        output.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "0");
        assert!(replacement.wait().unwrap().success());
    }
}
