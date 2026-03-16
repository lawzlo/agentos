import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
function defaultRunner(script, { cwd } = {}) {
    return execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], cwd ? { cwd } : undefined);
}
function escapePowerShellString(value) {
    return String(value).replaceAll("'", "''");
}
function escapeSendKeysText(value) {
    const replacements = new Map([
        ["+", "{+}"],
        ["^", "{^}"],
        ["%", "{%}"],
        ["~", "{~}"],
        ["(", "{(}"],
        [")", "{)}"],
        ["[", "{[}"],
        ["]", "{]}"],
        ["{", "{{}"],
        ["}", "{}}"]
    ]);
    return Array.from(String(value))
        .map((char) => {
        if (char === "\r") {
            return "";
        }
        if (char === "\n") {
            return "{ENTER}";
        }
        return replacements.get(char) ?? char;
    })
        .join("");
}
function normalizeKeyToken(key) {
    const normalized = String(key ?? "").trim().toLowerCase();
    const named = {
        return: "{ENTER}",
        enter: "{ENTER}",
        tab: "{TAB}",
        space: " ",
        escape: "{ESC}",
        esc: "{ESC}",
        delete: "{BACKSPACE}",
        backspace: "{BACKSPACE}",
        left: "{LEFT}",
        right: "{RIGHT}",
        up: "{UP}",
        down: "{DOWN}",
        home: "{HOME}",
        end: "{END}",
        pageup: "{PGUP}",
        pagedown: "{PGDN}"
    };
    if (named[normalized]) {
        return named[normalized];
    }
    if (normalized.length === 1) {
        return escapeSendKeysText(normalized);
    }
    return escapeSendKeysText(key);
}
function normalizeModifierPrefix(modifiers = []) {
    return modifiers
        .map((modifier) => String(modifier ?? "").trim().toLowerCase())
        .map((modifier) => {
        switch (modifier) {
            case "shift":
                return "+";
            case "control":
            case "ctrl":
                return "^";
            case "alt":
            case "option":
                return "%";
            default:
                return "";
        }
    })
        .join("");
}
function createWindowsOcrScript(filePath) {
    const escapedPath = escapePowerShellString(filePath);
    return `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
function Await($operation) { [System.WindowsRuntimeSystemExtensions]::AsTask($operation).GetAwaiter().GetResult() }
$file = Await([Windows.Storage.StorageFile]::GetFileFromPathAsync('${escapedPath}'))
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
`;
}
export class WindowsHostBridge {
    platform;
    runPowerShell;
    constructor({ platform = process.platform, runPowerShell = defaultRunner } = {}) {
        this.platform = platform;
        this.runPowerShell = runPowerShell;
    }
    #assertSupported() {
        if (this.platform !== "win32") {
            throw new Error("Windows host bridge can only run on Windows hosts.");
        }
    }
    async #runJson(script, options = {}) {
        const { stdout } = await this.runPowerShell(script, options);
        return stdout.trim() ? JSON.parse(stdout) : {};
    }
    async captureScreen(filePath) {
        this.#assertSupported();
        const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save('${escapePowerShellString(filePath)}')
@{ filePath = '${escapePowerShellString(filePath)}' } | ConvertTo-Json -Compress
`;
        return this.#runJson(script);
    }
    async launchApp(name) {
        this.#assertSupported();
        const escaped = escapePowerShellString(name);
        return this.#runJson(`
Start-Process -FilePath '${escaped}'
@{ launched = '${escaped}' } | ConvertTo-Json -Compress
`);
    }
    async focusApp(name) {
        this.#assertSupported();
        const escaped = escapePowerShellString(name);
        return this.#runJson(`
$shell = New-Object -ComObject WScript.Shell
$focused = [bool]$shell.AppActivate('${escaped}')
@{ focused = $focused; name = '${escaped}' } | ConvertTo-Json -Compress
`);
    }
    async getFrontmostApp() {
        this.#assertSupported();
        return this.#runJson(`
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
`);
    }
    async getPermissionsStatus() {
        this.#assertSupported();
        return {
            accessibility: true,
            screenRecording: true,
            note: "Windows desktop automation does not require separate Accessibility or Screen Recording consent like macOS."
        };
    }
    async listWindows() {
        this.#assertSupported();
        return this.#runJson(`
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
`);
    }
    async typeText(text) {
        this.#assertSupported();
        const sendText = escapeSendKeysText(text);
        return this.#runJson(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${escapePowerShellString(sendText)}')
@{ typed = ${String(text).length}; text = '${escapePowerShellString(text)}' } | ConvertTo-Json -Compress
`);
    }
    async pressKey(key, modifiers = []) {
        this.#assertSupported();
        const sequence = `${normalizeModifierPrefix(modifiers)}${normalizeKeyToken(key)}`;
        const escapedKey = escapePowerShellString(String(key));
        const serializedModifiers = modifiers.map((modifier) => `'${escapePowerShellString(modifier)}'`).join(", ");
        return this.#runJson(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${escapePowerShellString(sequence)}')
@{ pressed = $true; key = '${escapedKey}'; modifiers = @(${serializedModifiers}) } | ConvertTo-Json -Compress
`);
    }
    async moveMouse(x, y) {
        this.#assertSupported();
        return this.#runJson(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AgentOSMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
}
"@
[void][AgentOSMouse]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})
@{ ok = $true; x = ${Math.round(x)}; y = ${Math.round(y)} } | ConvertTo-Json -Compress
`);
    }
    async clickAt(x, y) {
        this.#assertSupported();
        return this.#runJson(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AgentOSMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
"@
[void][AgentOSMouse]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})
[AgentOSMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[AgentOSMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
@{ ok = $true; x = ${Math.round(x)}; y = ${Math.round(y)} } | ConvertTo-Json -Compress
`);
    }
    async scroll(dx, dy) {
        this.#assertSupported();
        return this.#runJson(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AgentOSMouse {
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
"@
[AgentOSMouse]::mouse_event(0x0800, 0, 0, ${Math.round(dy)}, [UIntPtr]::Zero)
@{ ok = $true; dx = ${Math.round(dx)}; dy = ${Math.round(dy)} } | ConvertTo-Json -Compress
`);
    }
    async ocrImage(filePath) {
        this.#assertSupported();
        return this.#runJson(createWindowsOcrScript(filePath));
    }
    async findText(filePath, query) {
        this.#assertSupported();
        const ocr = await this.ocrImage(filePath);
        const observations = Array.isArray(ocr.observations) ? ocr.observations : [];
        const queryLower = String(query ?? "").toLowerCase();
        const ranked = observations
            .map((observation) => {
            const text = String(observation.text ?? "");
            const lowered = text.toLowerCase();
            let score = 0;
            if (lowered === queryLower) {
                score = 2;
            }
            else if (lowered.includes(queryLower)) {
                score = 1;
            }
            return { score, observation };
        })
            .filter((entry) => entry.score > 0)
            .sort((left, right) => {
            if (left.score !== right.score) {
                return right.score - left.score;
            }
            const leftConfidence = Number(left.observation.confidence ?? 0);
            const rightConfidence = Number(right.observation.confidence ?? 0);
            return rightConfidence - leftConfidence;
        });
        if (!ranked.length) {
            return { found: false, count: observations.length };
        }
        return {
            found: true,
            match: ranked[0].observation,
            count: observations.length
        };
    }
    async runCommand(command, cwd = process.cwd()) {
        this.#assertSupported();
        return this.runPowerShell(command, { cwd });
    }
    async shutdown() { }
}
