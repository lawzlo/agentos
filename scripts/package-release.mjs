import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = process.cwd();
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith("--")) {
    continue;
  }
  const next = process.argv[index + 1];
  args.set(key, next && !next.startsWith("--") ? next : true);
  if (next && !next.startsWith("--")) {
    index += 1;
  }
}

const platform = String(args.get("--platform") ?? process.platform);
const jsonOutput = args.get("--json") === true;
const skipBuild = args.get("--skip-build") === true;
const bundledRuntimeInput = args.get("--node-runtime") ?? process.env.AGENTOS_BUNDLED_NODE_PATH ?? null;
const nativeBinaryInput = args.get("--native-binary") ?? process.env.AGENTOS_NATIVE_BINARY_PATH ?? null;
const releaseDirInput = args.get("--release-dir") ?? process.env.AGENTOS_RELEASE_DIR ?? null;
const skipBundledRuntime = args.get("--no-bundled-runtime") === true || process.env.AGENTOS_SKIP_BUNDLED_RUNTIME === "1";
const buildChannel = String(args.get("--channel") ?? process.env.AGENTOS_BUILD_CHANNEL ?? "stable");
const licenseEnforced = !(args.get("--source-mode") === true || process.env.AGENTOS_LICENSE_ENFORCED === "false");

function extensionForPlatform(targetPlatform) {
  return targetPlatform === "win32" ? ".exe" : "";
}

function runtimeExecutableName(targetPlatform) {
  return targetPlatform === "win32" ? "node.exe" : "node";
}

async function packageVersion() {
  return JSON.parse(await awaitRead(path.join(rootDir, "package.json"))).version;
}

async function awaitRead(filePath) {
  return fs.readFile(filePath, "utf8");
}

async function run(command, commandArgs, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: rootDir,
      stdio: "inherit",
      shell: process.platform === "win32",
      ...options
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${commandArgs.join(" ")} exited with code ${code ?? 1}`));
    });
    child.on("error", reject);
  });
}

async function copyDir(source, target) {
  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sourcePath, targetPath);
    } else {
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

function resolveInputPath(input) {
  if (!input) {
    return null;
  }
  return path.isAbsolute(input) ? input : path.resolve(rootDir, input);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveBundledRuntime(targetPlatform) {
  if (skipBundledRuntime) {
    return null;
  }

  const candidate = resolveInputPath(bundledRuntimeInput) ?? (targetPlatform === process.platform ? process.execPath : null);
  if (!candidate) {
    return null;
  }

  const stats = await fs.stat(candidate).catch(() => null);
  if (!stats) {
    throw new Error(`Bundled runtime path does not exist: ${candidate}`);
  }

  if (stats.isDirectory()) {
    const executableCandidates =
      targetPlatform === "win32"
        ? [path.join(candidate, "node.exe"), path.join(candidate, "bin", "node.exe")]
        : [path.join(candidate, "bin", "node"), path.join(candidate, "node")];
    for (const executablePath of executableCandidates) {
      if (await pathExists(executablePath)) {
        return {
          kind: "directory",
          sourcePath: candidate,
          relativeExecutable: path.relative(candidate, executablePath)
        };
      }
    }
    throw new Error(`Bundled runtime directory does not contain a ${runtimeExecutableName(targetPlatform)} executable: ${candidate}`);
  }

  return {
    kind: "file",
    sourcePath: candidate,
    relativeExecutable: runtimeExecutableName(targetPlatform)
  };
}

async function stageBundledRuntime(runtime, installRoot, targetPlatform) {
  if (!runtime) {
    return null;
  }

  const runtimeDir = path.join(installRoot, "runtime");
  if (runtime.kind === "directory") {
    await copyDir(runtime.sourcePath, runtimeDir);
  } else {
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.copyFile(runtime.sourcePath, path.join(runtimeDir, runtimeExecutableName(targetPlatform)));
  }

  const stagedExecutable = path.join(runtimeDir, runtime.relativeExecutable);
  if (targetPlatform !== "win32") {
    await fs.chmod(stagedExecutable, 0o755).catch(() => undefined);
  }

  return stagedExecutable;
}

function shellWrapper(version, runtimePath) {
  return `#!/bin/sh
set -eu
AGENTOS_ROOT="/opt/agentos/${version}"
AGENTOS_RUNTIME="${runtimePath ?? ""}"
if [ -n "$AGENTOS_RUNTIME" ] && [ -x "$AGENTOS_RUNTIME" ]; then
  exec "$AGENTOS_RUNTIME" "$AGENTOS_ROOT/dist/bin/agentos.js" "$@"
fi
exec node "$AGENTOS_ROOT/dist/bin/agentos.js" "$@"
`;
}

function windowsWrapper(version, runtimePath) {
  return `@echo off
setlocal
set "AGENTOS_ROOT=%ProgramFiles%\\AgentOS\\${version}"
set "AGENTOS_RUNTIME=${runtimePath ?? ""}"
if not "%AGENTOS_RUNTIME%"=="" if exist "%AGENTOS_RUNTIME%" (
  "%AGENTOS_RUNTIME%" "%AGENTOS_ROOT%\\dist\\bin\\agentos.js" %*
  exit /b %errorlevel%
)
node "%AGENTOS_ROOT%\\dist\\bin\\agentos.js" %*
`;
}

async function main() {
  const version = await packageVersion();
  const releaseDir = resolveInputPath(releaseDirInput) ?? path.join(rootDir, "release");
  const stageDir = path.join(releaseDir, "staging", platform);
  const nativeBinary =
    resolveInputPath(nativeBinaryInput) ??
    path.join(rootDir, "rust", "agentos-native", "target", "release", `agentos-native${extensionForPlatform(platform)}`);
  const bundledRuntime = await resolveBundledRuntime(platform);

  if (!skipBuild) {
    await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:ts"]);
    await run("cargo", ["build", "--manifest-path", "rust/agentos-native/Cargo.toml", "--release"]);
  }

  await fs.rm(stageDir, { recursive: true, force: true });
  await fs.mkdir(stageDir, { recursive: true });

  const distDir = path.join(rootDir, "dist");
  const manifest = {
    version,
    platform,
    stagedAt: new Date().toISOString(),
    buildChannel,
    licenseEnforced,
    bundledRuntime: Boolean(bundledRuntime),
    runtimeExecutable: null
  };

  if (platform === "darwin") {
    const installRoot = path.join(stageDir, "root", "opt", "agentos", version);
    const wrapperPath = path.join(stageDir, "root", "usr", "local", "bin", "agentos");
    const scriptsDir = path.join(stageDir, "scripts");
    const runtimeExecutablePath = await stageBundledRuntime(bundledRuntime, installRoot, platform);
    const runtimeExecutable = runtimeExecutablePath ? `/opt/agentos/${version}/${path.relative(installRoot, runtimeExecutablePath).replaceAll(path.sep, "/")}` : null;
    await copyDir(distDir, path.join(installRoot, "dist"));
    await fs.mkdir(path.join(installRoot, "bin"), { recursive: true });
    await fs.copyFile(nativeBinary, path.join(installRoot, "bin", "agentos-native"));
    await fs.copyFile(path.join(rootDir, "LICENSE"), path.join(installRoot, "LICENSE"));
    await fs.copyFile(path.join(rootDir, "README.md"), path.join(installRoot, "README.md"));
    await fs.mkdir(path.dirname(wrapperPath), { recursive: true });
    await fs.writeFile(wrapperPath, shellWrapper(version, runtimeExecutable), "utf8");
    await fs.chmod(wrapperPath, 0o755);
    await fs.writeFile(
      path.join(installRoot, "install-metadata.json"),
      JSON.stringify(
        {
          source: "macos_pkg",
          installRoot: `/opt/agentos/${version}`,
          wrapperPath: "/usr/local/bin/agentos",
          buildChannel,
          licenseEnforced,
          bundledRuntime: Boolean(runtimeExecutable),
          runtimeExecutablePath: runtimeExecutable
        },
        null,
        2
      ),
      "utf8"
    );
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(
      path.join(scriptsDir, "postinstall"),
      `#!/bin/sh
set -eu
/usr/local/bin/agentos version > /tmp/agentos-postinstall.log 2>&1 || true
`,
      "utf8"
    );
    await fs.chmod(path.join(scriptsDir, "postinstall"), 0o755);
    manifest.installRoot = `/opt/agentos/${version}`;
    manifest.wrapper = "/usr/local/bin/agentos";
    manifest.runtimeExecutable = runtimeExecutable;
  } else if (platform === "win32") {
    const installRoot = path.join(stageDir, "app", "AgentOS", version);
    const wrapperPath = path.join(stageDir, "app", "agentos.cmd");
    const runtimeExecutablePath = await stageBundledRuntime(bundledRuntime, installRoot, platform);
    const runtimeExecutable = runtimeExecutablePath
      ? `AgentOS\\${version}\\${path.relative(installRoot, runtimeExecutablePath).split(path.sep).join("\\")}`
      : null;
    await copyDir(distDir, path.join(installRoot, "dist"));
    await fs.mkdir(path.join(installRoot, "bin"), { recursive: true });
    await fs.copyFile(nativeBinary, path.join(installRoot, "bin", "agentos-native.exe"));
    await fs.copyFile(path.join(rootDir, "LICENSE"), path.join(installRoot, "LICENSE"));
    await fs.copyFile(path.join(rootDir, "README.md"), path.join(installRoot, "README.md"));
    await fs.writeFile(wrapperPath, windowsWrapper(version, runtimeExecutable ? `%ProgramFiles%\\${runtimeExecutable}` : null), "utf8");
    await fs.writeFile(
      path.join(installRoot, "install-metadata.json"),
      JSON.stringify(
        {
          source: "windows_msi",
          installRoot: `AgentOS\\${version}`,
          wrapperPath: "agentos.cmd",
          buildChannel,
          licenseEnforced,
          bundledRuntime: Boolean(runtimeExecutable),
          runtimeExecutablePath: runtimeExecutable ? `%ProgramFiles%\\${runtimeExecutable}` : null
        },
        null,
        2
      ),
      "utf8"
    );
    manifest.installRoot = `AgentOS\\${version}`;
    manifest.wrapper = "agentos.cmd";
    manifest.runtimeExecutable = runtimeExecutable ? `%ProgramFiles%\\${runtimeExecutable}` : null;
  } else {
    throw new Error(`Unsupported packaging platform: ${platform}`);
  }

  await fs.writeFile(path.join(stageDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  const payload = {
    ...manifest,
    stageDir
  };

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  console.log(`Staged AgentOS ${version} for ${platform} at ${stageDir}`);
}

await main();
