import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function powershell(script) {
  return execFileAsync("powershell.exe", ["-NoProfile", "-Command", script]);
}

export class WindowsHostBridge {
  #assertSupported() {
    if (process.platform !== "win32") {
      throw new Error("Windows host bridge can only run on Windows hosts.");
    }
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
      $bitmap.Save('${filePath.replaceAll("\\", "\\\\")}')
    `;
    await powershell(script);
    return { filePath };
  }

  async launchApp(name) {
    this.#assertSupported();
    await powershell(`Start-Process "${name.replaceAll("\"", "`\"")}"`);
    return { launched: name };
  }

  async focusApp() {
    this.#assertSupported();
    return { focused: false, note: "Application focusing is not implemented yet on Windows." };
  }

  async getFrontmostApp() {
    this.#assertSupported();
    const { stdout } = await powershell("(Get-Process | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object -First 1).ProcessName");
    return { appName: stdout.trim() };
  }

  async typeText() {
    this.#assertSupported();
    return { typed: 0, note: "Text injection is not implemented yet on Windows." };
  }

  async pressKey() {
    this.#assertSupported();
    return { pressed: false, note: "Key injection is not implemented yet on Windows." };
  }

  async runCommand(command, cwd = process.cwd()) {
    this.#assertSupported();
    const { stdout, stderr } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], { cwd });
    return { stdout, stderr };
  }
}
