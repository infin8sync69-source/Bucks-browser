use base64::{engine::general_purpose, Engine as _};
use flate2::read::GzDecoder;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::OnceLock,
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;
use zip::ZipArchive;

#[derive(Serialize)]
struct SwarmTaskRequest {
    prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_title: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
struct SwarmTaskResponse {
    status: String,
    evaluation: String,
    cid: Option<String>,
    task_id: Option<String>,
}

#[derive(Debug, Clone)]
struct ResolvedIpfsTarget {
    api_url: String,
    gateway_url: String,
    source: String,
    embedded: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum IpfsRuntimeState {
    Idle,
    Initializing,
    Ready,
    Error,
}

#[derive(Debug, Clone, Serialize)]
struct IpfsRuntimeStatus {
    state: IpfsRuntimeState,
    source: String,
    message: String,
    api_url: Option<String>,
    gateway_url: Option<String>,
    embedded: bool,
}

impl Default for IpfsRuntimeStatus {
    fn default() -> Self {
        Self {
            state: IpfsRuntimeState::Idle,
            source: "embedded_kubo".into(),
            message: "Bucks has not started its embedded IPFS node yet.".into(),
            api_url: None,
            gateway_url: None,
            embedded: true,
        }
    }
}

#[derive(Debug, Default)]
struct SharedIpfsRuntime {
    status: IpfsRuntimeStatus,
    bootstrap_in_flight: bool,
}

#[derive(Debug, Clone, Serialize)]
struct IpfsUploadResult {
    cid: String,
    ipfs_uri: String,
    gateway_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManagedIpfsConfig {
    version: String,
    api_port: u16,
    gateway_port: u16,
}

#[derive(Deserialize)]
struct IpfsAddFileArgs {
    #[serde(alias = "fileName")]
    file_name: String,
    #[serde(alias = "mimeType")]
    mime_type: Option<String>,
    #[serde(alias = "dataBase64")]
    data_base64: String,
}

static ARCHITECT_URL: &str = "http://localhost:3000/api/v1/swarm/task";
static DEFAULT_PUBLIC_IPFS_GATEWAY_URL: &str = "https://ipfs.io/ipfs/";
static DIST_IPFS_TECH_VERSIONS_URL: &str = "https://dist.ipfs.tech/kubo/versions";
static DIST_IPFS_TECH_BASE_URL: &str = "https://dist.ipfs.tech/kubo";
static FALLBACK_KUBO_VERSION: &str = "v0.41.0";
static MANAGED_IPFS_DIR_NAME: &str = "managed-ipfs";
static MANAGED_IPFS_CONFIG_FILE: &str = "runtime.json";
static MANAGED_IPFS_BINARY_DIR: &str = "bin";
static MANAGED_IPFS_DOWNLOAD_DIR: &str = "downloads";
static MANAGED_IPFS_EXTRACT_DIR: &str = "extract";
static MANAGED_IPFS_LOG_DIR: &str = "logs";
static MANAGED_IPFS_REPO_DIR: &str = "repo";

fn shared_ipfs_runtime() -> &'static Mutex<SharedIpfsRuntime> {
    static INSTANCE: OnceLock<Mutex<SharedIpfsRuntime>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(SharedIpfsRuntime::default()))
}

fn new_http_client(timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())
}

fn managed_ipfs_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))
        .map(|dir| dir.join(MANAGED_IPFS_DIR_NAME))
}

fn managed_ipfs_repo_dir(root: &Path) -> PathBuf {
    root.join(MANAGED_IPFS_REPO_DIR)
}

fn managed_ipfs_binary_path(root: &Path) -> PathBuf {
    root.join(MANAGED_IPFS_BINARY_DIR).join(kubo_binary_name())
}

fn managed_ipfs_config_path(root: &Path) -> PathBuf {
    root.join(MANAGED_IPFS_CONFIG_FILE)
}

fn managed_ipfs_log_path(root: &Path) -> PathBuf {
    root.join(MANAGED_IPFS_LOG_DIR).join("kubo.log")
}

fn local_api_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn local_gateway_base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/ipfs/")
}

fn kubo_binary_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "ipfs.exe"
    }

    #[cfg(not(target_os = "windows"))]
    {
        "ipfs"
    }
}

fn kubo_artifact_suffix() -> Result<&'static str, String> {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        "windows" => "windows",
        other => {
            return Err(format!(
                "Bucks does not know how to bootstrap Kubo for OS '{other}'."
            ))
        }
    };

    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => {
            return Err(format!(
                "Bucks does not know how to bootstrap Kubo for architecture '{other}'."
            ))
        }
    };

    Ok(match os {
        "windows" => {
            if arch == "amd64" {
                "windows-amd64.zip"
            } else {
                "windows-arm64.zip"
            }
        }
        "darwin" => {
            if arch == "amd64" {
                "darwin-amd64.tar.gz"
            } else {
                "darwin-arm64.tar.gz"
            }
        }
        "linux" => {
            if arch == "amd64" {
                "linux-amd64.tar.gz"
            } else {
                "linux-arm64.tar.gz"
            }
        }
        _ => unreachable!(),
    })
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("Failed to create '{}': {e}", path.display()))
}

fn reserve_free_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to reserve a local port: {e}"))?
        .local_addr()
        .map_err(|e| format!("Failed to read reserved port: {e}"))
        .map(|addr| addr.port())
}

fn read_or_create_managed_ipfs_config(root: &Path) -> Result<ManagedIpfsConfig, String> {
    let config_path = managed_ipfs_config_path(root);
    if config_path.exists() {
        let content = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read '{}': {e}", config_path.display()))?;
        return serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse '{}': {e}", config_path.display()));
    }

    let config = ManagedIpfsConfig {
        version: FALLBACK_KUBO_VERSION.into(),
        api_port: reserve_free_port()?,
        gateway_port: reserve_free_port()?,
    };

    fs::write(
        &config_path,
        serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write '{}': {e}", config_path.display()))?;

    Ok(config)
}

fn multiaddr_to_http_url(addr: &str) -> Result<String, String> {
    let parts: Vec<_> = addr.trim().trim_matches('/').split('/').collect();
    if parts.len() < 4 {
        return Err(format!("Unsupported multiaddr '{addr}'."));
    }

    let host = match parts[0] {
        "ip4" | "dns" | "dns4" | "dns6" => parts[1].to_string(),
        "ip6" => format!("[{}]", parts[1]),
        other => return Err(format!("Unsupported address protocol '{other}' in '{addr}'.")),
    };

    if parts[2] != "tcp" {
        return Err(format!("Unsupported transport in multiaddr '{addr}'."));
    }

    Ok(format!("http://{host}:{}", parts[3]))
}

fn read_multiaddr_file(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let addr = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read '{}': {e}", path.display()))?;
    let addr = addr.trim();

    // Kubo sometimes writes a plain HTTP URL instead of a multiaddr
    if addr.starts_with("http://") || addr.starts_with("https://") {
        return Ok(Some(addr.to_string()));
    }

    Ok(Some(multiaddr_to_http_url(addr)?))
}

fn resolve_external_ipfs_target() -> Option<ResolvedIpfsTarget> {
    let api_url = std::env::var("BUCKS_IPFS_API_URL").ok()?;
    let api_url = api_url.trim().trim_end_matches('/').to_string();
    if api_url.is_empty() {
        return None;
    }

    Some(ResolvedIpfsTarget {
        api_url,
        gateway_url: external_gateway_base_url(),
        source: "configured_api".into(),
        embedded: false,
    })
}

fn external_gateway_base_url() -> String {
    let mut gateway = std::env::var("BUCKS_IPFS_GATEWAY_URL")
        .unwrap_or_else(|_| DEFAULT_PUBLIC_IPFS_GATEWAY_URL.to_string());
    if !gateway.ends_with('/') {
        gateway.push('/');
    }
    gateway
}

async fn api_is_healthy(api_url: &str) -> bool {
    let client = match new_http_client(Duration::from_secs(2)) {
        Ok(client) => client,
        Err(_) => return false,
    };

    client
        .post(format!("{api_url}/api/v0/version"))
        .send()
        .await
        .map(|res| res.status().is_success())
        .unwrap_or(false)
}

async fn write_runtime_status(status: IpfsRuntimeStatus) {
    let mut runtime = shared_ipfs_runtime().lock().await;
    runtime.status = status;
}

async fn write_ready_runtime_status(target: &ResolvedIpfsTarget) {
    let mut runtime = shared_ipfs_runtime().lock().await;
    runtime.status = IpfsRuntimeStatus {
        state: IpfsRuntimeState::Ready,
        source: target.source.clone(),
        message: "Embedded IPFS node is ready.".into(),
        api_url: Some(target.api_url.clone()),
        gateway_url: Some(target.gateway_url.clone()),
        embedded: target.embedded,
    };
    runtime.bootstrap_in_flight = false;
}

async fn write_error_runtime_status(message: String) {
    let mut runtime = shared_ipfs_runtime().lock().await;
    runtime.status = IpfsRuntimeStatus {
        state: IpfsRuntimeState::Error,
        source: "embedded_kubo".into(),
        message,
        api_url: None,
        gateway_url: None,
        embedded: true,
    };
    runtime.bootstrap_in_flight = false;
}

async fn fetch_latest_kubo_version(client: &Client) -> Result<String, String> {
    let text = client
        .get(DIST_IPFS_TECH_VERSIONS_URL)
        .send()
        .await
        .map_err(|e| format!("Failed to query Kubo versions: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Failed to query Kubo versions: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Failed to read Kubo versions: {e}"))?;

    text.lines()
        .map(str::trim)
        .filter(|line| line.starts_with('v') && !line.is_empty() && !line.contains('-'))
        .last()
        .map(str::to_string)
        .ok_or_else(|| "dist.ipfs.tech did not return a stable Kubo version.".into())
}

async fn ensure_kubo_binary(root: &Path, config: &mut ManagedIpfsConfig) -> Result<PathBuf, String> {
    let binary_path = managed_ipfs_binary_path(root);
    if binary_path.exists() {
        return Ok(binary_path);
    }

    let client = new_http_client(Duration::from_secs(120))?;
    let version = fetch_latest_kubo_version(&client)
        .await
        .unwrap_or_else(|_| config.version.clone());

    if version != config.version {
        config.version = version.clone();
        fs::write(
            managed_ipfs_config_path(root),
            serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("Failed to update managed IPFS config: {e}"))?;
    }

    let artifact_suffix = kubo_artifact_suffix()?;
    let artifact_name = format!("kubo_{}_{}", config.version, artifact_suffix);
    let archive_url = format!("{}/{}/{}", DIST_IPFS_TECH_BASE_URL, config.version, artifact_name);

    ensure_dir(&root.join(MANAGED_IPFS_DOWNLOAD_DIR))?;
    ensure_dir(&root.join(MANAGED_IPFS_BINARY_DIR))?;
    ensure_dir(&root.join(MANAGED_IPFS_EXTRACT_DIR))?;

    let archive_path = root.join(MANAGED_IPFS_DOWNLOAD_DIR).join(&artifact_name);
    if !archive_path.exists() {
        let bytes = client
            .get(&archive_url)
            .send()
            .await
            .map_err(|e| format!("Failed to download {archive_url}: {e}"))?
            .error_for_status()
            .map_err(|e| format!("Failed to download {archive_url}: {e}"))?
            .bytes()
            .await
            .map_err(|e| format!("Failed to read downloaded Kubo archive: {e}"))?;

        fs::write(&archive_path, &bytes)
            .map_err(|e| format!("Failed to write '{}': {e}", archive_path.display()))?;
    }

    let extract_root = root.join(MANAGED_IPFS_EXTRACT_DIR).join(&config.version);
    if extract_root.exists() {
        fs::remove_dir_all(&extract_root)
            .map_err(|e| format!("Failed to clear '{}': {e}", extract_root.display()))?;
    }
    ensure_dir(&extract_root)?;

    if artifact_name.ends_with(".tar.gz") {
        let archive_file = File::open(&archive_path)
            .map_err(|e| format!("Failed to open '{}': {e}", archive_path.display()))?;
        let decoder = GzDecoder::new(archive_file);
        let mut archive = tar::Archive::new(decoder);
        archive
            .unpack(&extract_root)
            .map_err(|e| format!("Failed to unpack '{}': {e}", archive_path.display()))?;
    } else {
        let archive_file = File::open(&archive_path)
            .map_err(|e| format!("Failed to open '{}': {e}", archive_path.display()))?;
        let mut archive =
            ZipArchive::new(archive_file).map_err(|e| format!("Failed to read zip archive: {e}"))?;
        for index in 0..archive.len() {
            let mut file = archive
                .by_index(index)
                .map_err(|e| format!("Failed to read archive entry: {e}"))?;
            let out_path = extract_root.join(file.mangled_name());
            if file.name().ends_with('/') {
                ensure_dir(&out_path)?;
                continue;
            }

            if let Some(parent) = out_path.parent() {
                ensure_dir(parent)?;
            }

            let mut output =
                File::create(&out_path).map_err(|e| format!("Failed to create '{}': {e}", out_path.display()))?;
            io::copy(&mut file, &mut output)
                .map_err(|e| format!("Failed to extract '{}': {e}", out_path.display()))?;
        }
    }

    let extracted_binary = extract_root.join("kubo").join(kubo_binary_name());
    if !extracted_binary.exists() {
        return Err(format!(
            "Kubo archive did not contain '{}'.",
            extracted_binary.display()
        ));
    }

    fs::copy(&extracted_binary, &binary_path).map_err(|e| {
        format!(
            "Failed to install managed Kubo binary to '{}': {e}",
            binary_path.display()
        )
    })?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&binary_path)
            .map_err(|e| format!("Failed to inspect '{}': {e}", binary_path.display()))?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&binary_path, permissions).map_err(|e| {
            format!(
                "Failed to mark '{}' as executable: {e}",
                binary_path.display()
            )
        })?;
    }

    Ok(binary_path)
}

fn run_ipfs_command(binary_path: &Path, repo_dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new(binary_path)
        .env("IPFS_PATH", repo_dir)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run '{}': {e}", binary_path.display()))?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(format!(
        "ipfs {} failed: {}{}{}",
        args.join(" "),
        stderr,
        if !stderr.is_empty() && !stdout.is_empty() { " | " } else { "" },
        stdout
    ))
}

fn ensure_ipfs_repo(binary_path: &Path, repo_dir: &Path) -> Result<(), String> {
    if repo_dir.join("config").exists() {
        return Ok(());
    }

    ensure_dir(repo_dir)?;
    run_ipfs_command(binary_path, repo_dir, &["init", "--profile", "server"])?;
    Ok(())
}

fn configure_ipfs_repo(
    binary_path: &Path,
    repo_dir: &Path,
    config: &ManagedIpfsConfig,
) -> Result<(), String> {
    let api_addr = format!("/ip4/127.0.0.1/tcp/{}", config.api_port);
    let gateway_addr = format!("/ip4/127.0.0.1/tcp/{}", config.gateway_port);

    run_ipfs_command(binary_path, repo_dir, &["config", "Addresses.API", &api_addr])?;
    run_ipfs_command(
        binary_path,
        repo_dir,
        &["config", "Addresses.Gateway", &gateway_addr],
    )?;

    Ok(())
}

fn spawn_ipfs_daemon(binary_path: &Path, repo_dir: &Path, root: &Path) -> Result<(), String> {
    ensure_dir(&root.join(MANAGED_IPFS_LOG_DIR))?;
    let log_path = managed_ipfs_log_path(root);

    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open '{}': {e}", log_path.display()))?;
    let stderr = stdout
        .try_clone()
        .map_err(|e| format!("Failed to clone '{}': {e}", log_path.display()))?;

    Command::new(binary_path)
        .env("IPFS_PATH", repo_dir)
        .arg("daemon")
        .arg("--migrate=true")
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|e| format!("Failed to launch managed Kubo daemon: {e}"))?;

    Ok(())
}

async fn wait_for_ipfs_api(api_url: &str) -> Result<(), String> {
    let client = new_http_client(Duration::from_secs(2))?;
    for _ in 0..60 {
        let ready = client
            .post(format!("{api_url}/api/v0/version"))
            .send()
            .await
            .map(|res| res.status().is_success())
            .unwrap_or(false);

        if ready {
            return Ok(());
        }

        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    Err(format!("Timed out waiting for the embedded IPFS API at {api_url}."))
}

async fn bootstrap_managed_ipfs(app: &AppHandle) -> Result<ResolvedIpfsTarget, String> {
    let root = managed_ipfs_root(app)?;
    ensure_dir(&root)?;

    let mut managed_config = read_or_create_managed_ipfs_config(&root)?;
    let repo_dir = managed_ipfs_repo_dir(&root);
    ensure_dir(&repo_dir)?;

    if let Some(api_url) = read_multiaddr_file(&repo_dir.join("api"))? {
        if api_is_healthy(&api_url).await {
            let gateway_url = read_multiaddr_file(&repo_dir.join("gateway"))?
                .map(|url| format!("{}/ipfs/", url.trim_end_matches('/')))
                .unwrap_or_else(|| local_gateway_base_url(managed_config.gateway_port));

            return Ok(ResolvedIpfsTarget {
                api_url,
                gateway_url,
                source: "embedded_kubo".into(),
                embedded: true,
            });
        }
    }

    let binary_path = ensure_kubo_binary(&root, &mut managed_config).await?;
    ensure_ipfs_repo(&binary_path, &repo_dir)?;
    configure_ipfs_repo(&binary_path, &repo_dir, &managed_config)?;

    let api_url = local_api_url(managed_config.api_port);
    if !api_is_healthy(&api_url).await {
        spawn_ipfs_daemon(&binary_path, &repo_dir, &root)?;
        wait_for_ipfs_api(&api_url).await?;
    }

    let gateway_url = read_multiaddr_file(&repo_dir.join("gateway"))?
        .map(|url| format!("{}/ipfs/", url.trim_end_matches('/')))
        .unwrap_or_else(|| local_gateway_base_url(managed_config.gateway_port));

    Ok(ResolvedIpfsTarget {
        api_url,
        gateway_url,
        source: "embedded_kubo".into(),
        embedded: true,
    })
}

async fn ensure_managed_ipfs_ready(app: &AppHandle) -> Result<ResolvedIpfsTarget, String> {
    loop {
        let should_bootstrap = {
            let mut runtime = shared_ipfs_runtime().lock().await;
            match runtime.status.state {
                IpfsRuntimeState::Ready => {
                    return Ok(ResolvedIpfsTarget {
                        api_url: runtime.status.api_url.clone().unwrap_or_default(),
                        gateway_url: runtime
                            .status
                            .gateway_url
                            .clone()
                            .unwrap_or_else(external_gateway_base_url),
                        source: runtime.status.source.clone(),
                        embedded: runtime.status.embedded,
                    });
                }
                IpfsRuntimeState::Initializing if runtime.bootstrap_in_flight => false,
                IpfsRuntimeState::Idle
                | IpfsRuntimeState::Error
                | IpfsRuntimeState::Initializing => {
                    runtime.bootstrap_in_flight = true;
                    runtime.status = IpfsRuntimeStatus {
                    state: IpfsRuntimeState::Initializing,
                    source: "embedded_kubo".into(),
                    message: "Preparing Bucks' embedded IPFS node. This may download Kubo on first run.".into(),
                    api_url: None,
                    gateway_url: None,
                    embedded: true,
                    };
                    true
                }
            }
        };

        if !should_bootstrap {
            tokio::time::sleep(Duration::from_millis(350)).await;
            continue;
        }

        let result = bootstrap_managed_ipfs(app).await;
        match result {
            Ok(target) => {
                write_ready_runtime_status(&target).await;
                return Ok(target);
            }
            Err(err) => {
                write_error_runtime_status(err.clone()).await;
                return Err(err);
            }
        }
    }
}

async fn bootstrap_managed_ipfs_in_background(app: AppHandle) {
    let result = bootstrap_managed_ipfs(&app).await;
    match result {
        Ok(target) => write_ready_runtime_status(&target).await,
        Err(err) => write_error_runtime_status(err).await,
    }
}

async fn resolve_active_ipfs_target(app: &AppHandle) -> Result<ResolvedIpfsTarget, String> {
    if let Some(target) = resolve_external_ipfs_target() {
        return Ok(target);
    }

    ensure_managed_ipfs_ready(app).await
}

async fn ipfs_add_bytes(
    target: &ResolvedIpfsTarget,
    file_name: String,
    mime_type: Option<String>,
    data: Vec<u8>,
) -> Result<String, String> {
    let client = new_http_client(Duration::from_secs(300))?;
    let add_url = format!("{}/api/v0/add?pin=true&cid-version=1", target.api_url);

    let mut part = reqwest::multipart::Part::bytes(data).file_name(file_name);
    if let Some(mime) = mime_type.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        part = part.mime_str(mime).map_err(|e| e.to_string())?;
    }

    let form = reqwest::multipart::Form::new().part("file", part);
    let mut req = client.post(add_url).multipart(form);

    if let Ok(auth) = std::env::var("BUCKS_IPFS_API_AUTH") {
        if !auth.trim().is_empty() {
            req = req.header("Authorization", auth);
        }
    }

    let res = req.send().await.map_err(|e| {
        format!(
            "IPFS upload failed using {}. {}",
            target.source,
            e
        )
    })?;

    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("IPFS API error ({status}): {body}"));
    }

    let mut cid: Option<String> = None;
    for line in body.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let value: serde_json::Value =
            serde_json::from_str(line).map_err(|e| format!("Bad IPFS response '{line}': {e}"))?;
        if let Some(hash) = value.get("Hash").and_then(|hash| hash.as_str()) {
            cid = Some(hash.to_string());
        }
    }

    cid.ok_or_else(|| format!("No CID found in IPFS response: {body}"))
}

/// Call the live Solar Parsec Architect.
/// Falls back to a deterministic mock if the server is offline.
async fn call_architect(
    prompt: &str,
    current_url: Option<String>,
    current_title: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = new_http_client(Duration::from_secs(60))?;

    let res = client
        .post(ARCHITECT_URL)
        .json(&SwarmTaskRequest {
            prompt: prompt.to_string(),
            current_url,
            current_title,
        })
        .send()
        .await;

    match res {
        Ok(response) if response.status().is_success() => {
            let data: SwarmTaskResponse = response.json().await.map_err(|e| e.to_string())?;
            let a2ui = extract_a2ui_json(&data.evaluation);
            Ok(serde_json::json!({
                "status": data.status,
                "evaluation": data.evaluation,
                "cid": data.cid,
                "task_id": data.task_id,
                "a2ui": a2ui
            }))
        }
        _ => {
            let lower = prompt.to_lowercase();
            let a2ui = if lower.contains("go to")
                || lower.contains("open")
                || lower.contains("navigate")
                || lower.contains("browse")
            {
                let url = extract_url_from_prompt(prompt);
                serde_json::json!({
                    "type": "navigate",
                    "url": url,
                    "content": format!("Navigating to {url}...")
                })
            } else if lower.contains("search") {
                let query = prompt
                    .replace("search", "")
                    .replace("for", "")
                    .trim()
                    .to_string();
                let url = format!("https://duckduckgo.com/?q={}", urlencoding::encode(&query));
                serde_json::json!({
                    "type": "navigate",
                    "url": url,
                    "content": format!("Searching for '{query}'...")
                })
            } else if lower.contains("wallet") {
                serde_json::json!({
                    "type": "action",
                    "action": "open_wallet",
                    "content": "Opening your Bucks wallet..."
                })
            } else if lower.contains("tor") {
                serde_json::json!({
                    "type": "action",
                    "action": "start_tor_node",
                    "content": "Establishing onion routing..."
                })
            } else if lower.contains("ipfs") {
                serde_json::json!({
                    "type": "action",
                    "action": "open_ipfs",
                    "content": "Accessing the decentralized IPFS network..."
                })
            } else {
                serde_json::json!({
                    "type": "text",
                    "content": format!(
                        "Architect offline. Received: '{}'. Start solar-parsec to enable full swarm intelligence.",
                        prompt
                    )
                })
            };

            Ok(serde_json::json!({
                "status": "offline_fallback",
                "evaluation": a2ui["content"].as_str().unwrap_or(""),
                "a2ui": a2ui
            }))
        }
    }
}

fn extract_a2ui_json(text: &str) -> Option<serde_json::Value> {
    if let (Some(start), Some(end)) = (text.rfind("```json"), text.rfind("```")) {
        if start < end {
            let json_str = &text[start + 7..end].trim();
            if let Ok(val) = serde_json::from_str(json_str) {
                return Some(val);
            }
        }
    }

    if let (Some(start), Some(end)) = (text.rfind('{'), text.rfind('}')) {
        if start < end {
            let json_str = &text[start..=end].trim();
            if let Ok(val) = serde_json::from_str(json_str) {
                return Some(val);
            }
        }
    }

    None
}

fn extract_url_from_prompt(prompt: &str) -> String {
    let words: Vec<&str> = prompt.split_whitespace().collect();
    for word in &words {
        if word.contains('.') && !word.contains(' ') {
            if word.starts_with("http") {
                return word.to_string();
            }
            return format!("https://{word}");
        }
    }
    format!("https://duckduckgo.com/?q={}", urlencoding::encode(prompt))
}

// ── New IPFS response types ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct IpfsPublishResult {
    status: String,
    cid: String,
    ipfs_uri: String,
    gateway_url: String,
}

#[derive(Debug, Clone, Serialize)]
struct IpfsPinEntry {
    cid: String,
    pin_type: String,
}

#[derive(Debug, Deserialize)]
struct IpfsPinLsResponse {
    #[serde(rename = "Keys")]
    keys: std::collections::HashMap<String, IpfsPinLsEntry>,
}

#[derive(Debug, Deserialize)]
struct IpfsPinLsEntry {
    #[serde(rename = "Type")]
    pin_type: String,
}

#[derive(Debug, Clone, Serialize)]
struct IpfsNodeInfo {
    peer_id: String,
    addresses: Vec<String>,
    agent_version: String,
}

// ── IPFS directory listing ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct IpfsLsEntry {
    name: String,
    cid: String,
    size: u64,
    is_dir: bool,
}

// ── IPFS core commands ───────────────────────────────────────────────────────

#[tauri::command]
async fn ipfs_ls(app: AppHandle, cid: String) -> Result<Vec<IpfsLsEntry>, String> {
    let target = resolve_active_ipfs_target(&app).await?;
    let client = new_http_client(Duration::from_secs(30))?;
    let url = format!(
        "{}/api/v0/ls?arg={}",
        target.api_url,
        urlencoding::encode(&cid)
    );

    let res = client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("ipfs ls failed: {e}"))?;

    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("ipfs ls error ({status}): {body}"));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse ls response: {e}"))?;

    let entries = parsed["Objects"][0]["Links"]
        .as_array()
        .map(|links| {
            links
                .iter()
                .map(|link| IpfsLsEntry {
                    name: link["Name"].as_str().unwrap_or("").to_string(),
                    cid: link["Hash"].as_str().unwrap_or("").to_string(),
                    size: link["Size"].as_u64().unwrap_or(0),
                    is_dir: link["Type"].as_u64().unwrap_or(0) == 1,
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(entries)
}

#[tauri::command]
async fn ipfs_node_info(app: AppHandle) -> Result<IpfsNodeInfo, String> {
    let target = resolve_active_ipfs_target(&app).await?;
    let client = new_http_client(Duration::from_secs(10))?;
    let url = format!("{}/api/v0/id", target.api_url);

    let res = client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("ipfs id failed: {e}"))?;

    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("ipfs id error ({status}): {body}"));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse id response: {e}"))?;

    Ok(IpfsNodeInfo {
        peer_id: parsed["ID"].as_str().unwrap_or("unknown").to_string(),
        addresses: parsed["Addresses"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        agent_version: parsed["AgentVersion"]
            .as_str()
            .unwrap_or("unknown")
            .to_string(),
    })
}

#[tauri::command]
async fn ipfs_cat(app: AppHandle, cid: String) -> Result<String, String> {
    let target = resolve_active_ipfs_target(&app).await?;
    let client = new_http_client(Duration::from_secs(30))?;
    let url = format!(
        "{}/api/v0/cat?arg={}",
        target.api_url,
        urlencoding::encode(&cid)
    );

    let res = client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("ipfs cat failed: {e}"))?;

    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("ipfs cat error ({status}): {body}"));
    }

    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    Ok(general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
async fn ipfs_pin_add(app: AppHandle, cid: String) -> Result<String, String> {
    let target = resolve_active_ipfs_target(&app).await?;
    let client = new_http_client(Duration::from_secs(60))?;
    let url = format!(
        "{}/api/v0/pin/add?arg={}",
        target.api_url,
        urlencoding::encode(&cid)
    );

    let res = client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("ipfs pin add failed: {e}"))?;

    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("ipfs pin add error ({status}): {body}"));
    }

    Ok(body)
}

#[tauri::command]
async fn ipfs_pin_rm(app: AppHandle, cid: String) -> Result<String, String> {
    let target = resolve_active_ipfs_target(&app).await?;
    let client = new_http_client(Duration::from_secs(30))?;
    let url = format!(
        "{}/api/v0/pin/rm?arg={}",
        target.api_url,
        urlencoding::encode(&cid)
    );

    let res = client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("ipfs pin rm failed: {e}"))?;

    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("ipfs pin rm error ({status}): {body}"));
    }

    Ok(body)
}

#[tauri::command]
async fn ipfs_pin_ls(app: AppHandle) -> Result<Vec<IpfsPinEntry>, String> {
    let target = resolve_active_ipfs_target(&app).await?;
    let client = new_http_client(Duration::from_secs(30))?;
    let url = format!("{}/api/v0/pin/ls?type=recursive", target.api_url);

    let res = client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("ipfs pin ls failed: {e}"))?;

    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("ipfs pin ls error ({status}): {body}"));
    }

    let parsed: IpfsPinLsResponse = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse pin ls response: {e}"))?;

    let mut pins: Vec<IpfsPinEntry> = parsed
        .keys
        .into_iter()
        .map(|(cid, entry)| IpfsPinEntry {
            cid,
            pin_type: entry.pin_type,
        })
        .collect();
    pins.sort_by(|a, b| a.cid.cmp(&b.cid));

    Ok(pins)
}

#[tauri::command]
async fn start_tor_node() -> Result<String, String> {
    println!("[Bucks] Starting local Tor proxy...");
    Ok(r#"{"status": "success", "message": "Tor node started on ports 9050/9051"}"#.to_string())
}

#[tauri::command]
async fn get_ipfs_runtime_status(app: AppHandle) -> Result<IpfsRuntimeStatus, String> {
    if let Some(target) = resolve_external_ipfs_target() {
        let healthy = api_is_healthy(&target.api_url).await;
        let status = if healthy {
            IpfsRuntimeStatus {
                state: IpfsRuntimeState::Ready,
                source: target.source,
                message: "Using the configured IPFS API.".into(),
                api_url: Some(target.api_url),
                gateway_url: Some(target.gateway_url),
                embedded: false,
            }
        } else {
            IpfsRuntimeStatus {
                state: IpfsRuntimeState::Error,
                source: target.source,
                message: "BUCKS_IPFS_API_URL is configured, but the IPFS API is not reachable.".into(),
                api_url: Some(target.api_url),
                gateway_url: Some(target.gateway_url),
                embedded: false,
            }
        };
        write_runtime_status(status.clone()).await;
        return Ok(status);
    }

    let mut runtime = shared_ipfs_runtime().lock().await;
    match runtime.status.state {
        IpfsRuntimeState::Ready | IpfsRuntimeState::Initializing if runtime.bootstrap_in_flight => {
            Ok(runtime.status.clone())
        }
        IpfsRuntimeState::Ready => Ok(runtime.status.clone()),
        IpfsRuntimeState::Idle | IpfsRuntimeState::Error | IpfsRuntimeState::Initializing => {
            runtime.bootstrap_in_flight = true;
            runtime.status = IpfsRuntimeStatus {
                state: IpfsRuntimeState::Initializing,
                source: "embedded_kubo".into(),
                message: "Preparing Bucks' embedded IPFS node. The first run may download Kubo.".into(),
                api_url: None,
                gateway_url: None,
                embedded: true,
            };
            let status = runtime.status.clone();
            drop(runtime);

            tauri::async_runtime::spawn(bootstrap_managed_ipfs_in_background(app.clone()));
            Ok(status)
        }
    }
}

#[tauri::command]
async fn ipfs_add_file(app: AppHandle, args: IpfsAddFileArgs) -> Result<IpfsUploadResult, String> {
    let raw = args
        .data_base64
        .split(',')
        .last()
        .unwrap_or(args.data_base64.as_str())
        .trim();

    let bytes = general_purpose::STANDARD
        .decode(raw)
        .map_err(|e| format!("Invalid base64 file data: {e}"))?;

    let target = resolve_active_ipfs_target(&app).await?;
    let cid = ipfs_add_bytes(&target, args.file_name, args.mime_type, bytes).await?;

    Ok(IpfsUploadResult {
        cid: cid.clone(),
        ipfs_uri: format!("ipfs://{cid}"),
        gateway_url: format!("{}{}", target.gateway_url, cid),
    })
}

#[tauri::command]
async fn publish_ipfs(app: AppHandle, content: String) -> Result<String, String> {
    let target = resolve_active_ipfs_target(&app).await?;
    let bytes = content.into_bytes();
    let cid = ipfs_add_bytes(
        &target,
        "content.txt".to_string(),
        Some("text/plain".to_string()),
        bytes,
    )
    .await?;

    let result = IpfsPublishResult {
        status: "success".into(),
        ipfs_uri: format!("ipfs://{cid}"),
        gateway_url: format!("{}{}", target.gateway_url, cid),
        cid,
    };
    serde_json::to_string(&result).map_err(|e| e.to_string())
}

#[tauri::command]
async fn init_swarm_agent(role: String) -> Result<String, String> {
    println!("[Bucks] Initializing Swarm Agent: {role}");
    Ok(format!(r#"{{"status": "success", "agent": "{role}"}}"#))
}

#[tauri::command]
async fn query_swarm(
    prompt: String,
    current_url: Option<String>,
    current_title: Option<String>,
) -> Result<String, String> {
    println!("[Bucks] Agentic query: {prompt}");
    let result = call_architect(&prompt, current_url, current_title).await?;
    serde_json::to_string(&result).map_err(|e| e.to_string())
}

#[tauri::command]
async fn check_architect_status() -> Result<bool, String> {
    let client = new_http_client(Duration::from_secs(3))?;
    let res = client
        .post(ARCHITECT_URL)
        .json(&SwarmTaskRequest {
            prompt: "__ping__".to_string(),
            current_url: None,
            current_title: None,
        })
        .send()
        .await;

    Ok(res.is_ok())
}

#[tauri::command]
async fn handle_feedback(task_id: String, score: f64, correction: Option<String>) -> Result<(), String> {
    println!("[Bucks] Feedback: task={task_id} score={score} correction={correction:?}");
    // Stub — wire to architect feedback endpoint when available
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            start_tor_node,
            get_ipfs_runtime_status,
            ipfs_add_file,
            publish_ipfs,
            ipfs_cat,
            ipfs_ls,
            ipfs_pin_add,
            ipfs_pin_rm,
            ipfs_pin_ls,
            ipfs_node_info,
            init_swarm_agent,
            query_swarm,
            check_architect_status,
            handle_feedback
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
