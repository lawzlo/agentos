import fs from "node:fs";
import path from "node:path";
const CHROME_CANDIDATES = {
    darwin: [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium"
    ],
    win32: [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
    ],
    linux: [
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser"
    ]
};
function firstExisting(paths) {
    return paths.find((entry) => fs.existsSync(entry));
}
export function detectBrowserExecutable() {
    if (process.env.AGENTOS_BROWSER_EXECUTABLE) {
        return process.env.AGENTOS_BROWSER_EXECUTABLE;
    }
    return firstExisting(CHROME_CANDIDATES[process.platform] ?? []);
}
export function resolveConfig(overrides = {}) {
    const dataDir = overrides.dataDir ??
        process.env.AGENTOS_DATA_DIR ??
        path.join(process.cwd(), ".agentos");
    const daemonDir = path.join(dataDir, "daemon");
    return {
        port: Number(overrides.port ?? process.env.PORT ?? 3017),
        dataDir,
        daemonDir,
        dbPath: path.join(dataDir, "agentos.sqlite"),
        masterKeyPath: path.join(dataDir, "master.key"),
        inboxDir: path.join(dataDir, "inbox"),
        headless: overrides.headless ?? process.env.AGENTOS_HEADLESS !== "false",
        browserExecutable: overrides.browserExecutable ?? detectBrowserExecutable(),
        livePacks: overrides.livePacks ?? null,
        model: {
            baseUrl: overrides.model?.baseUrl ?? process.env.MODEL_BASE_URL,
            apiKey: overrides.model?.apiKey ?? process.env.MODEL_API_KEY,
            name: overrides.model?.name ?? process.env.MODEL_NAME,
            timeoutMs: Number(overrides.model?.timeoutMs ?? process.env.MODEL_TIMEOUT_MS ?? 45000)
        }
    };
}
