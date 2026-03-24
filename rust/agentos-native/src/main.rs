use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::ffi::{CStr, CString};
use std::io::{self, BufRead, Write};
use std::os::raw::c_char;
use std::process::Command;

const NATIVE_PROTOCOL_VERSION: u32 = 1;

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn agentos_macos_permissions_status_json() -> *mut c_char;
    fn agentos_macos_list_windows_json() -> *mut c_char;
    fn agentos_macos_ocr_image_json(path: *const c_char) -> *mut c_char;
    fn agentos_macos_ocr_image_region_json(
        path: *const c_char,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        scale: f64,
    ) -> *mut c_char;
    fn agentos_macos_find_text_json(path: *const c_char, query: *const c_char) -> *mut c_char;
    fn agentos_macos_type_text_json(text: *const c_char) -> *mut c_char;
    fn agentos_macos_key_press_json(key: *const c_char, modifiers_csv: *const c_char) -> *mut c_char;
    fn agentos_macos_click_at_json(x: f64, y: f64) -> *mut c_char;
    fn agentos_macos_move_mouse_json(x: f64, y: f64) -> *mut c_char;
    fn agentos_macos_scroll_json(dx: f64, dy: f64) -> *mut c_char;
    fn agentos_macos_free_string(value: *mut c_char);
}

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

#[derive(Clone, Copy)]
struct NormalizedRegion {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
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
            "appVersion": env!("CARGO_PKG_VERSION"),
            "nativeProtocolVersion": NATIVE_PROTOCOL_VERSION,
            "helperAvailable": matches!(env::consts::OS, "windows" | "macos"),
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
        "capture_screen" => capture_screen(
            param_string(&request.params, "filePath")?,
            request
                .params
                .get("windowNumber")
                .and_then(|value| value.as_u64())
                .map(|value| value as u32),
        ),
        "launch_app" => launch_app(param_string(&request.params, "name")?),
        "focus_app" => focus_app(param_string(&request.params, "name")?),
        "frontmost_app" => frontmost_app(),
        "permissions_status" => permissions_status(),
        "list_windows" => list_windows(),
        "ocr_image" => ocr_image(
            param_string(&request.params, "filePath")?,
            optional_normalized_region(&request.params, "region")?,
            request
                .params
                .get("scale")
                .and_then(|value| value.as_f64())
                .filter(|value| value.is_finite() && *value > 0.0),
        ),
        "find_text" => find_text(
            param_string(&request.params, "filePath")?,
            param_string(&request.params, "query")?,
        ),
        "type_text" => match env::consts::OS {
            "macos" => macos_type_text(param_string(&request.params, "text")?),
            "windows" => windows_type_text(param_string(&request.params, "text")?),
            other => Err(format!("type_text is not available on {other}")),
        },
        "key_press" => {
            let key = param_string(&request.params, "key")?;
            let modifiers = request
                .params
                .get("modifiers")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default();
            match env::consts::OS {
                "macos" => macos_key_press(key, modifiers),
                "windows" => windows_key_press(key, modifiers),
                other => Err(format!("key_press is not available on {other}")),
            }
        }
        "click_at" => match env::consts::OS {
            "macos" => macos_click_at(
                param_number(&request.params, "x")?,
                param_number(&request.params, "y")?,
            ),
            "windows" => windows_click_at(
                param_number(&request.params, "x")?,
                param_number(&request.params, "y")?,
            ),
            other => Err(format!("click_at is not available on {other}")),
        },
        "move_mouse" => match env::consts::OS {
            "macos" => macos_move_mouse(
                param_number(&request.params, "x")?,
                param_number(&request.params, "y")?,
            ),
            "windows" => windows_move_mouse(
                param_number(&request.params, "x")?,
                param_number(&request.params, "y")?,
            ),
            other => Err(format!("move_mouse is not available on {other}")),
        },
        "scroll" => match env::consts::OS {
            "macos" => macos_scroll(
                param_number(&request.params, "dx")?,
                param_number(&request.params, "dy")?,
            ),
            "windows" => windows_scroll(
                param_number(&request.params, "dx")?,
                param_number(&request.params, "dy")?,
            ),
            other => Err(format!("scroll is not available on {other}")),
        },
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

fn optional_normalized_region(params: &Value, key: &str) -> Result<Option<NormalizedRegion>, String> {
    let Some(value) = params.get(key) else {
        return Ok(None);
    };
    let Some(region) = value.as_object() else {
        return Err(format!("{key} must be an object"));
    };
    let x = region
        .get("x")
        .and_then(|entry| entry.as_f64())
        .ok_or_else(|| format!("{key}.x is required"))?;
    let y = region
        .get("y")
        .and_then(|entry| entry.as_f64())
        .ok_or_else(|| format!("{key}.y is required"))?;
    let width = region
        .get("width")
        .and_then(|entry| entry.as_f64())
        .ok_or_else(|| format!("{key}.width is required"))?;
    let height = region
        .get("height")
        .and_then(|entry| entry.as_f64())
        .ok_or_else(|| format!("{key}.height is required"))?;
    if ![x, y, width, height].iter().all(|value| value.is_finite()) {
        return Err(format!("{key} must contain finite numbers"));
    }
    if width <= 0.0 || height <= 0.0 {
        return Err(format!("{key}.width and {key}.height must be greater than 0"));
    }
    Ok(Some(NormalizedRegion {
        x,
        y,
        width,
        height,
    }))
}

fn capture_screen(file_path: String, window_number: Option<u32>) -> Result<Value, String> {
    match env::consts::OS {
        "macos" => {
            let mut args = vec!["-x"];
            let window_number_string;
            if let Some(window_number) = window_number {
                args.push("-o");
                args.push("-l");
                window_number_string = window_number.to_string();
                args.push(window_number_string.as_str());
            }
            args.push(file_path.as_str());
            run_command("screencapture", &args)?;
            Ok(json!({ "filePath": file_path, "windowNumber": window_number }))
        }
        "windows" => windows_capture_screen(file_path),
        other => Err(format!("capture_screen is not available on {other}")),
    }
}

fn launch_app(name: String) -> Result<Value, String> {
    match env::consts::OS {
        "macos" => {
            run_command("open", &["-a", name.as_str()])?;
            Ok(json!({ "launched": name }))
        }
        "windows" => windows_launch_app(name),
        other => Err(format!("launch_app is not available on {other}")),
    }
}

fn focus_app(name: String) -> Result<Value, String> {
    match env::consts::OS {
        "macos" => {
            run_command("open", &["-a", name.as_str()])?;
            run_command(
                "osascript",
                &["-e", &format!("tell application \"{}\" to activate", escape_applescript(&name))],
            )?;
            run_command(
                "osascript",
                &[
                    "-e",
                    &format!(
                        "tell application \"System Events\" to set frontmost of process \"{}\" to true",
                        escape_applescript(&name)
                    ),
                ],
            )?;
            Ok(json!({ "focused": name }))
        }
        "windows" => windows_focus_app(name),
        other => Err(format!("focus_app is not available on {other}")),
    }
}

fn frontmost_app() -> Result<Value, String> {
    match env::consts::OS {
        "macos" => {
            let output = run_command_output(
                "osascript",
                &[
                    "-e",
                    "tell application \"System Events\" to get name of first application process whose frontmost is true",
                ],
            )?;
            Ok(json!({ "appName": output.trim() }))
        }
        "windows" => windows_frontmost_app(),
        other => Err(format!("frontmost_app is not available on {other}")),
    }
}

fn permissions_status() -> Result<Value, String> {
    match env::consts::OS {
        "macos" => macos_permissions_status(),
        "windows" => Ok(json!({
            "accessibility": true,
            "screenRecording": true,
            "note": "Windows desktop automation does not require separate Accessibility or Screen Recording consent like macOS."
        })),
        other => Err(format!("permissions_status is not available on {other}")),
    }
}

fn list_windows() -> Result<Value, String> {
    match env::consts::OS {
        "macos" => macos_list_windows(),
        "windows" => windows_list_windows(),
        other => Err(format!("list_windows is not available on {other}")),
    }
}

fn ocr_image(
    file_path: String,
    region: Option<NormalizedRegion>,
    scale: Option<f64>,
) -> Result<Value, String> {
    match env::consts::OS {
        "macos" => macos_ocr_image(file_path, region, scale),
        "windows" => windows_ocr_image(file_path),
        other => Err(format!("ocr_image is not available on {other}")),
    }
}

fn find_text(file_path: String, query: String) -> Result<Value, String> {
    match env::consts::OS {
        "macos" => macos_find_text(file_path, query),
        "windows" => windows_find_text(file_path, query),
        other => Err(format!("find_text is not available on {other}")),
    }
}

fn escape_applescript(input: &str) -> String {
    input.replace('\\', "\\\\").replace('\"', "\\\"")
}

#[cfg(target_os = "macos")]
fn macos_json_from_ptr(ptr: *mut c_char) -> Result<Value, String> {
    if ptr.is_null() {
        return Err("macOS native bridge returned a null response".to_string());
    }

    let raw = unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned();
    unsafe {
        agentos_macos_free_string(ptr);
    }
    serde_json::from_str(&raw).map_err(|error| format!("invalid macOS native response: {error}"))
}

#[cfg(target_os = "macos")]
fn macos_string_arg(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| "macOS native bridge does not support embedded NUL bytes".to_string())
}

#[cfg(target_os = "macos")]
fn macos_permissions_status() -> Result<Value, String> {
    macos_json_from_ptr(unsafe { agentos_macos_permissions_status_json() })
}

#[cfg(not(target_os = "macos"))]
fn macos_permissions_status() -> Result<Value, String> {
    Err(format!("permissions_status is not available on {}", env::consts::OS))
}

#[cfg(target_os = "macos")]
fn macos_list_windows() -> Result<Value, String> {
    macos_json_from_ptr(unsafe { agentos_macos_list_windows_json() })
}

#[cfg(not(target_os = "macos"))]
fn macos_list_windows() -> Result<Value, String> {
    Err(format!("list_windows is not available on {}", env::consts::OS))
}

#[cfg(target_os = "macos")]
fn macos_ocr_image(
    file_path: String,
    region: Option<NormalizedRegion>,
    scale: Option<f64>,
) -> Result<Value, String> {
    let file_path = macos_string_arg(&file_path)?;
    if let Some(region) = region {
        macos_json_from_ptr(unsafe {
            agentos_macos_ocr_image_region_json(
                file_path.as_ptr(),
                region.x,
                region.y,
                region.width,
                region.height,
                scale.unwrap_or(1.0),
            )
        })
    } else {
        macos_json_from_ptr(unsafe { agentos_macos_ocr_image_json(file_path.as_ptr()) })
    }
}

#[cfg(not(target_os = "macos"))]
fn macos_ocr_image(
    _file_path: String,
    _region: Option<NormalizedRegion>,
    _scale: Option<f64>,
) -> Result<Value, String> {
    Err(format!("ocr_image is not available on {}", env::consts::OS))
}

#[cfg(target_os = "macos")]
fn macos_find_text(file_path: String, query: String) -> Result<Value, String> {
    let file_path = macos_string_arg(&file_path)?;
    let query = macos_string_arg(&query)?;
    macos_json_from_ptr(unsafe { agentos_macos_find_text_json(file_path.as_ptr(), query.as_ptr()) })
}

#[cfg(not(target_os = "macos"))]
fn macos_find_text(_file_path: String, _query: String) -> Result<Value, String> {
    Err(format!("find_text is not available on {}", env::consts::OS))
}

#[cfg(target_os = "macos")]
fn macos_type_text(text: String) -> Result<Value, String> {
    let text = macos_string_arg(&text)?;
    macos_json_from_ptr(unsafe { agentos_macos_type_text_json(text.as_ptr()) })
}

#[cfg(not(target_os = "macos"))]
fn macos_type_text(_text: String) -> Result<Value, String> {
    Err(format!("type_text is not available on {}", env::consts::OS))
}

#[cfg(target_os = "macos")]
fn macos_key_press(key: String, modifiers: Vec<Value>) -> Result<Value, String> {
    let key = macos_string_arg(&key)?;
    let modifiers_csv = modifiers
        .iter()
        .filter_map(|item| item.as_str())
        .collect::<Vec<&str>>()
        .join(",");
    let modifiers_csv = macos_string_arg(&modifiers_csv)?;
    macos_json_from_ptr(unsafe { agentos_macos_key_press_json(key.as_ptr(), modifiers_csv.as_ptr()) })
}

#[cfg(not(target_os = "macos"))]
fn macos_key_press(_key: String, _modifiers: Vec<Value>) -> Result<Value, String> {
    Err(format!("key_press is not available on {}", env::consts::OS))
}

#[cfg(target_os = "macos")]
fn macos_click_at(x: f64, y: f64) -> Result<Value, String> {
    macos_json_from_ptr(unsafe { agentos_macos_click_at_json(x, y) })
}

#[cfg(not(target_os = "macos"))]
fn macos_click_at(_x: f64, _y: f64) -> Result<Value, String> {
    Err(format!("click_at is not available on {}", env::consts::OS))
}

#[cfg(target_os = "macos")]
fn macos_move_mouse(x: f64, y: f64) -> Result<Value, String> {
    macos_json_from_ptr(unsafe { agentos_macos_move_mouse_json(x, y) })
}

#[cfg(not(target_os = "macos"))]
fn macos_move_mouse(_x: f64, _y: f64) -> Result<Value, String> {
    Err(format!("move_mouse is not available on {}", env::consts::OS))
}

#[cfg(target_os = "macos")]
fn macos_scroll(dx: f64, dy: f64) -> Result<Value, String> {
    macos_json_from_ptr(unsafe { agentos_macos_scroll_json(dx, dy) })
}

#[cfg(not(target_os = "macos"))]
fn macos_scroll(_dx: f64, _dy: f64) -> Result<Value, String> {
    Err(format!("scroll is not available on {}", env::consts::OS))
}

fn escape_powershell(input: &str) -> String {
    input.replace('\'', "''")
}

fn escape_send_keys_text(input: &str) -> String {
    input
        .chars()
        .filter_map(|character| match character {
            '\r' => None,
            '\n' => Some("{ENTER}".to_string()),
            '+' => Some("{+}".to_string()),
            '^' => Some("{^}".to_string()),
            '%' => Some("{%}".to_string()),
            '~' => Some("{~}".to_string()),
            '(' => Some("{(}".to_string()),
            ')' => Some("{)}".to_string()),
            '[' => Some("{[}".to_string()),
            ']' => Some("{]}".to_string()),
            '{' => Some("{{}".to_string()),
            '}' => Some("{}}".to_string()),
            other => Some(other.to_string()),
        })
        .collect::<Vec<String>>()
        .join("")
}

fn normalize_key_token(input: &str) -> String {
    let normalized = input.trim().to_lowercase();
    match normalized.as_str() {
        "return" | "enter" => "{ENTER}".to_string(),
        "tab" => "{TAB}".to_string(),
        "space" => " ".to_string(),
        "escape" | "esc" => "{ESC}".to_string(),
        "delete" | "backspace" => "{BACKSPACE}".to_string(),
        "left" => "{LEFT}".to_string(),
        "right" => "{RIGHT}".to_string(),
        "up" => "{UP}".to_string(),
        "down" => "{DOWN}".to_string(),
        "home" => "{HOME}".to_string(),
        "end" => "{END}".to_string(),
        "pageup" => "{PGUP}".to_string(),
        "pagedown" => "{PGDN}".to_string(),
        "f1" => "{F1}".to_string(),
        "f2" => "{F2}".to_string(),
        "f3" => "{F3}".to_string(),
        "f4" => "{F4}".to_string(),
        "f5" => "{F5}".to_string(),
        "f6" => "{F6}".to_string(),
        "f7" => "{F7}".to_string(),
        "f8" => "{F8}".to_string(),
        "f9" => "{F9}".to_string(),
        "f10" => "{F10}".to_string(),
        "f11" => "{F11}".to_string(),
        "f12" => "{F12}".to_string(),
        _ if normalized.chars().count() == 1 => escape_send_keys_text(normalized.as_str()),
        _ => escape_send_keys_text(input),
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_key_token;

    #[test]
    fn normalize_key_token_supports_navigation_keys() {
        assert_eq!(normalize_key_token("tab"), "{TAB}");
        assert_eq!(normalize_key_token("escape"), "{ESC}");
        assert_eq!(normalize_key_token("pageDown"), "{PGDN}");
    }

    #[test]
    fn normalize_key_token_supports_function_keys() {
        assert_eq!(normalize_key_token("F1"), "{F1}");
        assert_eq!(normalize_key_token("f6"), "{F6}");
        assert_eq!(normalize_key_token("F12"), "{F12}");
    }
}

fn normalize_modifier_prefix(modifiers: &[Value]) -> String {
    modifiers
        .iter()
        .filter_map(|item| item.as_str())
        .map(|modifier| match modifier.trim().to_lowercase().as_str() {
            "shift" => "+",
            "control" | "ctrl" => "^",
            "alt" | "option" => "%",
            _ => "",
        })
        .collect::<Vec<&str>>()
        .join("")
}

fn run_powershell_json(script: &str) -> Result<Value, String> {
    let output = run_command_output("powershell.exe", &["-NoProfile", "-Command", script])?;
    serde_json::from_str(&output).map_err(|error| format!("invalid PowerShell response: {error}"))
}

fn windows_capture_screen(file_path: String) -> Result<Value, String> {
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save('__PATH__')
@{ filePath = '__PATH__' } | ConvertTo-Json -Compress
"#
    .replace("__PATH__", &escape_powershell(&file_path));
    run_powershell_json(&script)
}

fn windows_launch_app(name: String) -> Result<Value, String> {
    let script = r#"
Start-Process -FilePath '__NAME__'
@{ launched = '__NAME__' } | ConvertTo-Json -Compress
"#
    .replace("__NAME__", &escape_powershell(&name));
    run_powershell_json(&script)
}

fn windows_focus_app(name: String) -> Result<Value, String> {
    let script = r#"
$shell = New-Object -ComObject WScript.Shell
$focused = [bool]$shell.AppActivate('__NAME__')
@{ focused = $focused; name = '__NAME__' } | ConvertTo-Json -Compress
"#
    .replace("__NAME__", &escape_powershell(&name));
    run_powershell_json(&script)
}

fn windows_frontmost_app() -> Result<Value, String> {
    run_powershell_json(
        r#"
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AgentOSForegroundWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
}
"@
$hwnd = [AgentOSForegroundWindow]::GetForegroundWindow()
$processId = 0
[void][AgentOSForegroundWindow]::GetWindowThreadProcessId($hwnd, [ref]$processId)
$length = [AgentOSForegroundWindow]::GetWindowTextLength($hwnd)
$builder = New-Object System.Text.StringBuilder ($length + 1)
[void][AgentOSForegroundWindow]::GetWindowText($hwnd, $builder, $builder.Capacity)
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
@{
  appName = if ($process) { $process.ProcessName } else { '' }
  processId = [int]$processId
  windowTitle = $builder.ToString()
  mainWindowTitle = if ($process) { $process.MainWindowTitle } else { $builder.ToString() }
} | ConvertTo-Json -Compress
"#,
    )
}

fn windows_list_windows() -> Result<Value, String> {
    run_powershell_json(
        r#"
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AgentOSWindowEnumerator {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$windows = New-Object System.Collections.ArrayList
$callback = [AgentOSWindowEnumerator+EnumWindowsProc]{
  param($hWnd, $lParam)
  if (-not [AgentOSWindowEnumerator]::IsWindowVisible($hWnd)) { return $true }
  $length = [AgentOSWindowEnumerator]::GetWindowTextLength($hWnd)
  if ($length -le 0) { return $true }
  $builder = New-Object System.Text.StringBuilder ($length + 1)
  [void][AgentOSWindowEnumerator]::GetWindowText($hWnd, $builder, $builder.Capacity)
  $title = $builder.ToString()
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }
  $processId = 0
  [void][AgentOSWindowEnumerator]::GetWindowThreadProcessId($hWnd, [ref]$processId)
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  $rect = New-Object AgentOSWindowEnumerator+RECT
  [void][AgentOSWindowEnumerator]::GetWindowRect($hWnd, [ref]$rect)
  [void]$windows.Add([pscustomobject]@{
    windowNumber = [int64]$hWnd
    ownerName = if ($process) { $process.ProcessName } else { '' }
    windowName = $title
    ownerPID = [int]$processId
    layer = 0
    alpha = 1
    bounds = [pscustomobject]@{
      x = [double]$rect.Left
      y = [double]$rect.Top
      width = [double]($rect.Right - $rect.Left)
      height = [double]($rect.Bottom - $rect.Top)
      centerX = [double]($rect.Left + (($rect.Right - $rect.Left) / 2))
      centerY = [double]($rect.Top + (($rect.Bottom - $rect.Top) / 2))
    }
  })
  return $true
}
[void][AgentOSWindowEnumerator]::EnumWindows($callback, [IntPtr]::Zero)
@{ windows = @($windows) } | ConvertTo-Json -Compress -Depth 8
"#,
    )
}

fn create_windows_ocr_script(file_path: &str) -> String {
    r#"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
function Await($operation) { [System.WindowsRuntimeSystemExtensions]::AsTask($operation).GetAwaiter().GetResult() }
$file = Await([Windows.Storage.StorageFile]::GetFileFromPathAsync('__PATH__'))
$stream = Await($file.OpenAsync([Windows.Storage.FileAccessMode]::Read))
$decoder = Await([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream))
$bitmap = Await($decoder.GetSoftwareBitmapAsync())
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$result = Await($engine.RecognizeAsync($bitmap))
$observations = foreach ($line in $result.Lines) {
  foreach ($word in $line.Words) {
    $bounds = $word.BoundingRect
    [pscustomobject]@{
      text = $word.Text
      confidence = 0.8
      box = [pscustomobject]@{
        x = [double]$bounds.X
        y = [double]$bounds.Y
        width = [double]$bounds.Width
        height = [double]$bounds.Height
        centerX = [double]($bounds.X + ($bounds.Width / 2))
        centerY = [double]($bounds.Y + ($bounds.Height / 2))
      }
    }
  }
}
@{ observations = @($observations) } | ConvertTo-Json -Compress -Depth 8
"#
    .replace("__PATH__", &escape_powershell(file_path))
}

fn windows_ocr_image(file_path: String) -> Result<Value, String> {
    run_powershell_json(&create_windows_ocr_script(&file_path))
}

fn windows_find_text(file_path: String, query: String) -> Result<Value, String> {
    let ocr = windows_ocr_image(file_path)?;
    let observations = ocr
        .get("observations")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let query_lower = query.to_lowercase();
    let mut ranked = observations
        .iter()
        .filter_map(|observation| {
            let text = observation.get("text")?.as_str()?.to_string();
            let lowered = text.to_lowercase();
            let score = if lowered == query_lower {
                2
            } else if lowered.contains(query_lower.as_str()) {
                1
            } else {
                0
            };
            if score == 0 {
                return None;
            }
            let confidence = observation
                .get("confidence")
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0);
            Some((score, confidence, observation.clone()))
        })
        .collect::<Vec<(i32, f64, Value)>>();
    ranked.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| right.1.partial_cmp(&left.1).unwrap_or(std::cmp::Ordering::Equal))
    });

    if let Some((_, _, observation)) = ranked.first() {
        Ok(json!({
            "found": true,
            "match": observation,
            "count": observations.len()
        }))
    } else {
        Ok(json!({
            "found": false,
            "count": observations.len()
        }))
    }
}

fn windows_type_text(text: String) -> Result<Value, String> {
    let send_text = escape_send_keys_text(&text);
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('__TEXT__')
@{ typed = __COUNT__; text = '__RAW__' } | ConvertTo-Json -Compress
"#
    .replace("__TEXT__", &escape_powershell(&send_text))
    .replace("__RAW__", &escape_powershell(&text))
    .replace("__COUNT__", text.len().to_string().as_str());
    run_powershell_json(&script)
}

fn windows_key_press(key: String, modifiers: Vec<Value>) -> Result<Value, String> {
    let sequence = format!(
        "{}{}",
        normalize_modifier_prefix(modifiers.as_slice()),
        normalize_key_token(&key)
    );
    let serialized_modifiers = modifiers
        .iter()
        .filter_map(|item| item.as_str())
        .map(|value| format!("'{}'", escape_powershell(value)))
        .collect::<Vec<String>>()
        .join(", ");
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('__SEQUENCE__')
@{ pressed = $true; key = '__KEY__'; modifiers = @(__MODIFIERS__) } | ConvertTo-Json -Compress
"#
    .replace("__SEQUENCE__", &escape_powershell(&sequence))
    .replace("__KEY__", &escape_powershell(&key))
    .replace("__MODIFIERS__", &serialized_modifiers);
    run_powershell_json(&script)
}

fn windows_move_mouse(x: f64, y: f64) -> Result<Value, String> {
    let script = format!(
        r#"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AgentOSMouse {{
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
}}
"@
[void][AgentOSMouse]::SetCursorPos({}, {})
@{{ ok = $true; x = {}; y = {} }} | ConvertTo-Json -Compress
"#,
        x.round() as i64,
        y.round() as i64,
        x.round() as i64,
        y.round() as i64
    );
    run_powershell_json(&script)
}

fn windows_click_at(x: f64, y: f64) -> Result<Value, String> {
    let script = format!(
        r#"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AgentOSMouse {{
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}}
"@
[void][AgentOSMouse]::SetCursorPos({}, {})
[AgentOSMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[AgentOSMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
@{{ ok = $true; x = {}; y = {} }} | ConvertTo-Json -Compress
"#,
        x.round() as i64,
        y.round() as i64,
        x.round() as i64,
        y.round() as i64
    );
    run_powershell_json(&script)
}

fn windows_scroll(dx: f64, dy: f64) -> Result<Value, String> {
    let script = format!(
        r#"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AgentOSMouse {{
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}}
"@
[AgentOSMouse]::mouse_event(0x0800, 0, 0, {}, [UIntPtr]::Zero)
@{{ ok = $true; dx = {}; dy = {} }} | ConvertTo-Json -Compress
"#,
        dy.round() as i64,
        dx.round() as i64,
        dy.round() as i64
    );
    run_powershell_json(&script)
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
