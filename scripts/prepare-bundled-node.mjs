import crypto from "node:crypto";
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

const jsonOutput = args.get("--json") === true;
const planOnly = args.get("--plan-only") === true;

function resolveInputPath(input) {
  if (!input) {
    return null;
  }
  return path.isAbsolute(input) ? input : path.resolve(rootDir, input);
}

function normalizeVersion(input) {
  const raw = String(input ?? "").trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(raw)) {
    throw new Error(`Expected a full Node.js version like 22.18.0, received: ${input ?? "(empty)"}`);
  }
  return raw;
}

function archiveSpec(platform, arch) {
  const normalizedArch = arch === "x64" || arch === "arm64" ? arch : null;
  if (!normalizedArch) {
    throw new Error(`Unsupported Node.js runtime architecture for packaging: ${arch}`);
  }

  if (platform === "darwin") {
    return {
      archiveExt: ".tar.gz",
      distPlatform: "darwin",
      executableRelativePath: "bin/node"
    };
  }

  if (platform === "win32") {
    return {
      archiveExt: ".zip",
      distPlatform: "win",
      executableRelativePath: "node.exe"
    };
  }

  throw new Error(`Unsupported packaging platform for bundled Node.js runtime: ${platform}`);
}

function buildPlan({
  platform = process.platform,
  arch = process.arch,
  version = process.env.AGENTOS_NODE_RUNTIME_VERSION ?? process.version,
  baseUrl = process.env.AGENTOS_NODE_DIST_BASE_URL ?? "https://nodejs.org/dist",
  releaseDir = process.env.AGENTOS_RELEASE_DIR ?? path.join(rootDir, "release")
} = {}) {
  const normalizedVersion = normalizeVersion(version);
  const spec = archiveSpec(platform, arch);
  const runtimeBasename = `node-v${normalizedVersion}-${spec.distPlatform}-${arch}`;
  const archiveName = `${runtimeBasename}${spec.archiveExt}`;
  const resolvedReleaseDir = resolveInputPath(releaseDir) ?? path.join(rootDir, "release");
  const runtimeBaseDir = path.join(resolvedReleaseDir, "bundled-runtime", `${platform}-${arch}`, `node-v${normalizedVersion}`);

  return {
    platform,
    arch,
    version: normalizedVersion,
    baseUrl,
    archiveName,
    downloadUrl: `${String(baseUrl).replace(/\/$/, "")}/v${normalizedVersion}/${archiveName}`,
    checksumUrl: `${String(baseUrl).replace(/\/$/, "")}/v${normalizedVersion}/SHASUMS256.txt`,
    archivePath: path.join(runtimeBaseDir, "downloads", archiveName),
    extractRoot: path.join(runtimeBaseDir, "runtime"),
    runtimeRoot: path.join(runtimeBaseDir, "runtime", runtimeBasename),
    executablePath: path.join(runtimeBaseDir, "runtime", runtimeBasename, spec.executableRelativePath),
    executableRelativePath: spec.executableRelativePath,
    runtimeBasename
  };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function run(command, commandArgs) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: rootDir,
      stdio: "inherit",
      shell: process.platform === "win32"
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

async function downloadFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destination, bytes);
  return bytes;
}

async function verifyChecksum(plan) {
  const shasums = await fetch(plan.checksumUrl);
  if (!shasums.ok) {
    throw new Error(`Failed to fetch ${plan.checksumUrl}: ${shasums.status} ${shasums.statusText}`);
  }

  const manifest = await shasums.text();
  const expectedLine = manifest
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.endsWith(`  ${plan.archiveName}`));
  if (!expectedLine) {
    throw new Error(`Checksum entry not found for ${plan.archiveName}`);
  }

  const [expectedHash] = expectedLine.split(/\s+/u);
  const archiveBytes = await fs.readFile(plan.archivePath);
  const actualHash = crypto.createHash("sha256").update(archiveBytes).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(`Checksum mismatch for ${plan.archiveName}`);
  }
}

async function extractArchive(plan) {
  await fs.rm(plan.extractRoot, { recursive: true, force: true });
  await fs.mkdir(plan.extractRoot, { recursive: true });

  if (plan.archiveName.endsWith(".tar.gz")) {
    await run("tar", ["-xzf", plan.archivePath, "-C", plan.extractRoot]);
    return;
  }

  if (plan.archiveName.endsWith(".zip")) {
    await run("pwsh", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${plan.archivePath.replaceAll("'", "''")}' -DestinationPath '${plan.extractRoot.replaceAll("'", "''")}' -Force`
    ]);
    return;
  }

  throw new Error(`Unsupported bundled runtime archive: ${plan.archiveName}`);
}

async function ensureBundledRuntime(plan) {
  if (await pathExists(plan.executablePath)) {
    return {
      ...plan,
      cached: true,
      downloaded: false,
      verified: false
    };
  }

  await downloadFile(plan.downloadUrl, plan.archivePath);
  await verifyChecksum(plan);
  await extractArchive(plan);

  if (!(await pathExists(plan.executablePath))) {
    throw new Error(`Bundled Node.js runtime is missing the expected executable: ${plan.executablePath}`);
  }

  if (process.platform !== "win32") {
    await fs.chmod(plan.executablePath, 0o755).catch(() => undefined);
  }

  return {
    ...plan,
    cached: false,
    downloaded: true,
    verified: true
  };
}

async function main() {
  const plan = buildPlan({
    platform: args.get("--platform") ?? process.platform,
    arch: args.get("--arch") ?? process.arch,
    version: args.get("--version") ?? process.env.AGENTOS_NODE_RUNTIME_VERSION ?? process.version,
    baseUrl: args.get("--base-url") ?? process.env.AGENTOS_NODE_DIST_BASE_URL ?? "https://nodejs.org/dist",
    releaseDir: args.get("--release-dir") ?? process.env.AGENTOS_RELEASE_DIR ?? path.join(rootDir, "release")
  });

  const payload = planOnly ? { ...plan, cached: false, downloaded: false, verified: false } : await ensureBundledRuntime(plan);

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  console.log(`Prepared bundled Node.js runtime ${payload.version} for ${payload.platform}/${payload.arch} at ${payload.runtimeRoot}`);
}

await main();

