use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::process::Command;

#[derive(Deserialize)]
struct Request {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize)]
struct Response {
    id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let raw = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("stdin read error: {error}");
                break;
            }
        };

        if raw.trim().is_empty() {
            continue;
        }

        let request: Request = match serde_json::from_str(&raw) {
            Ok(request) => request,
            Err(error) => {
                let response = Response {
                    id: "invalid".to_string(),
                    ok: false,
                    result: None,
                    error: Some(format!("invalid request: {error}")),
                };
                write_response(&mut stdout, &response);
                continue;
            }
        };

        let response = match handle_request(&request) {
            Ok(result) => Response {
                id: request.id.clone(),
                ok: true,
                result: Some(result),
                error: None,
            },
            Err(error) => Response {
                id: request.id.clone(),
                ok: false,
                result: None,
                error: Some(error),
            },
        };

        write_response(&mut stdout, &response);
    }
}

fn write_response(stdout: &mut io::Stdout, response: &Response) {
    match serde_json::to_string(response) {
        Ok(serialized) => {
            let _ = writeln!(stdout, "{serialized}");
            let _ = stdout.flush();
        }
        Err(error) => {
            eprintln!("response serialization error: {error}");
        }
    }
}

fn handle_request(request: &Request) -> Result<Value, String> {
    match request.method.as_str() {
        "health" => Ok(json!({
            "platform": env::consts::OS,
            "helperAvailable": helper_path().is_some(),
            "methods": [
                "health",
                "capture_screen",
                "launch_app",
                "focus_app",
                "frontmost_app",
                "permissions_status",
                "list_windows",
                "ocr_image",
                "find_text",
                "type_text",
                "key_press",
                "click_at",
                "move_mouse",
                "scroll"
            ]
        })),
        "capture_screen" => capture_screen(param_string(&request.params, "filePath")?),
        "launch_app" => launch_app(param_string(&request.params, "name")?),
        "focus_app" => focus_app(param_string(&request.params, "name")?),
        "frontmost_app" => frontmost_app(),
        "permissions_status" => permissions_status(),
        "list_windows" => list_windows(),
        "ocr_image" => ocr_image(param_string(&request.params, "filePath")?),
        "find_text" => find_text(
            param_string(&request.params, "filePath")?,
            param_string(&request.params, "query")?,
        ),
        "type_text" => helper_command("type-text", vec![param_string(&request.params, "text")?]),
        "key_press" => helper_command(
            "key-press",
            vec![
                param_string(&request.params, "key")?,
                request
                    .params
                    .get("modifiers")
                    .and_then(|value| value.as_array())
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item.as_str())
                            .collect::<Vec<&str>>()
                            .join(",")
                    })
                    .unwrap_or_default(),
            ],
        ),
        "click_at" => helper_command(
            "click-at",
            vec![
                param_number(&request.params, "x")?.to_string(),
                param_number(&request.params, "y")?.to_string(),
            ],
        ),
        "move_mouse" => helper_command(
            "move-mouse",
            vec![
                param_number(&request.params, "x")?.to_string(),
                param_number(&request.params, "y")?.to_string(),
            ],
        ),
        "scroll" => helper_command(
            "scroll",
            vec![
                param_number(&request.params, "dx")?.to_string(),
                param_number(&request.params, "dy")?.to_string(),
            ],
        ),
        _ => Err(format!("unsupported method: {}", request.method)),
    }
}

fn param_string(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .ok_or_else(|| format!("{key} is required"))
}

fn param_number(params: &Value, key: &str) -> Result<f64, String> {
    params
        .get(key)
        .and_then(|value| value.as_f64())
        .ok_or_else(|| format!("{key} is required"))
}

fn ensure_macos() -> Result<(), String> {
    if env::consts::OS != "macos" {
        return Err(format!("agentos-native macOS actions are not available on {}", env::consts::OS));
    }

    Ok(())
}

fn capture_screen(file_path: String) -> Result<Value, String> {
    ensure_macos()?;
    run_command("screencapture", &["-x", file_path.as_str()])?;
    Ok(json!({ "filePath": file_path }))
}

fn launch_app(name: String) -> Result<Value, String> {
    ensure_macos()?;
    run_command("open", &["-a", name.as_str()])?;
    Ok(json!({ "launched": name }))
}

fn focus_app(name: String) -> Result<Value, String> {
    ensure_macos()?;
    run_command(
        "osascript",
        &["-e", &format!("tell application \"{}\" to activate", escape_applescript(&name))],
    )?;
    Ok(json!({ "focused": name }))
}

fn frontmost_app() -> Result<Value, String> {
    ensure_macos()?;
    let output = run_command_output(
        "osascript",
        &[
            "-e",
            "tell application \"System Events\" to get name of first application process whose frontmost is true",
        ],
    )?;
    Ok(json!({ "appName": output.trim() }))
}

fn permissions_status() -> Result<Value, String> {
    helper_command("permissions-status", vec![])
}

fn list_windows() -> Result<Value, String> {
    helper_command("list-windows", vec![])
}

fn ocr_image(file_path: String) -> Result<Value, String> {
    helper_command("ocr-image", vec![file_path])
}

fn find_text(file_path: String, query: String) -> Result<Value, String> {
    helper_command("find-text", vec![file_path, query])
}

fn helper_command(command: &str, args: Vec<String>) -> Result<Value, String> {
    ensure_macos()?;
    let helper = helper_path().ok_or_else(|| "macOS helper is not available for this method".to_string())?;
    let mut all_args = vec![command.to_string()];
    all_args.extend(args);
    let output = run_command_output(helper.to_string_lossy().as_ref(), &all_args.iter().map(String::as_str).collect::<Vec<&str>>())?;
    serde_json::from_str(&output).map_err(|error| format!("invalid helper response: {error}"))
}

fn helper_path() -> Option<PathBuf> {
    if let Ok(path) = env::var("AGENTOS_MAC_HELPER_EXECUTABLE") {
      let candidate = PathBuf::from(path);
      if candidate.exists() {
          return Some(candidate);
      }
    }

    if let Ok(data_dir) = env::var("AGENTOS_DATA_DIR") {
        let candidate = PathBuf::from(data_dir).join("bin").join("agentos-macos-helper");
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

fn escape_applescript(input: &str) -> String {
    input.replace('\\', "\\\\").replace('\"', "\\\"")
}

fn run_command(command: &str, args: &[&str]) -> Result<(), String> {
    let status = Command::new(command)
        .args(args)
        .status()
        .map_err(|error| format!("failed to run {command}: {error}"))?;

    if status.success() {
        return Ok(());
    }

    Err(format!("{command} exited with status {status}"))
}

fn run_command_output(command: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(command)
        .args(args)
        .output()
        .map_err(|error| format!("failed to run {command}: {error}"))?;

    if output.status.success() {
        return String::from_utf8(output.stdout).map_err(|error| format!("utf8 decode failed: {error}"));
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("{command} exited with status {}", output.status)
    } else {
        stderr
    })
}
