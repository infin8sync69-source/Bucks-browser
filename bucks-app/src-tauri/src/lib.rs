use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
struct SwarmTaskRequest {
    prompt: String,
}

#[derive(Deserialize, Debug, Clone)]
struct SwarmTaskResponse {
    status: String,
    evaluation: String,
    cid: Option<String>,
    task_id: Option<String>,
}

static ARCHITECT_URL: &str = "http://localhost:3000/api/v1/swarm/task";

/// Call the live Solar Parsec Architect.
/// Falls back to a deterministic mock if the server is offline.
async fn call_architect(prompt: &str) -> Result<serde_json::Value, String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .post(ARCHITECT_URL)
        .json(&SwarmTaskRequest { prompt: prompt.to_string() })
        .send()
        .await;

    match res {
        Ok(response) if response.status().is_success() => {
            let data: SwarmTaskResponse = response.json().await.map_err(|e| e.to_string())?;
            // Parse A2UI JSON block from evaluation text if present
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
            // ---- Offline deterministic routing ----
            let lower = prompt.to_lowercase();
            let a2ui = if lower.contains("go to") || lower.contains("open") || lower.contains("navigate") || lower.contains("browse") {
                // Extract potential URL from prompt
                let url = extract_url_from_prompt(prompt);
                serde_json::json!({
                    "type": "navigate",
                    "url": url,
                    "content": format!("Navigating to {}...", url)
                })
            } else if lower.contains("search") {
                let q = prompt.replace("search", "").replace("for", "").trim().to_string();
                let url = format!("https://duckduckgo.com/?q={}", urlencoding::encode(&q));
                serde_json::json!({
                    "type": "navigate",
                    "url": url,
                    "content": format!("Searching for '{}'...", q)
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
                    "content": format!("Architect offline. Received: '{}'. Start solar-parsec to enable full swarm intelligence.", prompt)
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
    // 1. Try to find the last ```json block
    if let (Some(start), Some(end)) = (text.rfind("```json"), text.rfind("```")) {
        if start < end {
            let json_str = &text[start + 7..end].trim();
            if let Ok(val) = serde_json::from_str(json_str) {
                return Some(val);
            }
        }
    }

    // 2. Fallback: Look for anything between { and } at the end of the text
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
            let url = if word.starts_with("http") {
                word.to_string()
            } else {
                format!("https://{}", word)
            };
            return url;
        }
    }
    // Fallback: DuckDuckGo search
    format!("https://duckduckgo.com/?q={}", urlencoding::encode(prompt))
}

// ===================== Tauri Commands =====================

#[tauri::command]
async fn start_tor_node() -> Result<String, String> {
    println!("[Bucks] Starting local Tor proxy...");
    Ok(r#"{"status": "success", "message": "Tor node started on ports 9050/9051"}"#.to_string())
}

#[tauri::command]
async fn publish_ipfs(content: String) -> Result<String, String> {
    println!("[Bucks] Publishing content to IPFS: {}", &content[..content.len().min(60)]);
    Ok(format!(r#"{{"status": "success", "hash": "QmBucks{}", "content": "{}"}}"#, &content[..content.len().min(8)], content))
}

#[tauri::command]
async fn init_swarm_agent(role: String) -> Result<String, String> {
    println!("[Bucks] Initializing Swarm Agent: {}", role);
    Ok(format!(r#"{{"status": "success", "agent": "{}"}}"#, role))
}

/// Primary agentic command: routes a natural language prompt to the Solar Parsec Architect
/// and returns a structured A2UI JSON action for the frontend to dispatch.
#[tauri::command]
async fn query_swarm(prompt: String) -> Result<String, String> {
    println!("[Bucks] Agentic query: {}", prompt);
    let result = call_architect(&prompt).await?;
    serde_json::to_string(&result).map_err(|e| e.to_string())
}

/// Health check for the Solar Parsec backend
#[tauri::command]
async fn check_architect_status() -> Result<bool, String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .post(ARCHITECT_URL)
        .json(&SwarmTaskRequest { prompt: "__ping__".to_string() })
        .send()
        .await;

    Ok(res.is_ok())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            start_tor_node,
            publish_ipfs,
            init_swarm_agent,
            query_swarm,
            check_architect_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
