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

function extensionForPlatform(targetPlatform) {
  return targetPlatform === "win32" ? ".exe" : "";
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

function shellWrapper(version) {
  return `#!/bin/sh
set -eu
exec node "/opt/agentos/${version}/dist/bin/agentos.js" "$@"
`;
}

function windowsWrapper(version) {
  return `@echo off
setlocal
node "%ProgramFiles%\\AgentOS\\${version}\\dist\\bin\\agentos.js" %*
`;
}

async function main() {
  const version = await packageVersion();
  const releaseDir = path.join(rootDir, "release");
  const stageDir = path.join(releaseDir, "staging", platform);
  const nativeBinary = path.join(
    rootDir,
    "rust",
    "agentos-native",
    "target",
    "release",
    `agentos-native${extensionForPlatform(platform)}`
  );

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
    stagedAt: new Date().toISOString()
  };

  if (platform === "darwin") {
    const installRoot = path.join(stageDir, "root", "opt", "agentos", version);
    const wrapperPath = path.join(stageDir, "root", "usr", "local", "bin", "agentos");
    const scriptsDir = path.join(stageDir, "scripts");
    await copyDir(distDir, path.join(installRoot, "dist"));
    await fs.mkdir(path.join(installRoot, "bin"), { recursive: true });
    await fs.copyFile(nativeBinary, path.join(installRoot, "bin", "agentos-native"));
    await fs.copyFile(path.join(rootDir, "LICENSE"), path.join(installRoot, "LICENSE"));
    await fs.copyFile(path.join(rootDir, "README.md"), path.join(installRoot, "README.md"));
    await fs.mkdir(path.dirname(wrapperPath), { recursive: true });
    await fs.writeFile(wrapperPath, shellWrapper(version), "utf8");
    await fs.chmod(wrapperPath, 0o755);
    await fs.writeFile(
      path.join(installRoot, "install-metadata.json"),
      JSON.stringify(
        {
          source: "macos_pkg",
          installRoot: `/opt/agentos/${version}`,
          wrapperPath: "/usr/local/bin/agentos"
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
  } else if (platform === "win32") {
    const installRoot = path.join(stageDir, "app", "AgentOS", version);
    const wrapperPath = path.join(stageDir, "app", "agentos.cmd");
    await copyDir(distDir, path.join(installRoot, "dist"));
    await fs.mkdir(path.join(installRoot, "bin"), { recursive: true });
    await fs.copyFile(nativeBinary, path.join(installRoot, "bin", "agentos-native.exe"));
    await fs.copyFile(path.join(rootDir, "LICENSE"), path.join(installRoot, "LICENSE"));
    await fs.copyFile(path.join(rootDir, "README.md"), path.join(installRoot, "README.md"));
    await fs.writeFile(wrapperPath, windowsWrapper(version), "utf8");
    await fs.writeFile(
      path.join(installRoot, "install-metadata.json"),
      JSON.stringify(
        {
          source: "windows_msi",
          installRoot: `AgentOS\\${version}`,
          wrapperPath: "agentos.cmd"
        },
        null,
        2
      ),
      "utf8"
    );
    manifest.installRoot = `AgentOS\\${version}`;
    manifest.wrapper = "agentos.cmd";
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
