import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = process.cwd();

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit"
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? 1}`));
    });
    child.on("error", reject);
  });
}

async function ensureCommand(command) {
  await execFileAsync("which", [command]);
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("macOS packaging must run on a macOS host.");
  }

  await run(process.execPath, ["scripts/package-release.mjs", "--platform", "darwin"]);

  const pkg = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
  const version = pkg.version;
  const stageDir = path.join(rootDir, "release", "staging", "darwin");
  const rootPath = path.join(stageDir, "root");
  const scriptsPath = path.join(stageDir, "scripts");
  const artifactsDir = path.join(rootDir, "release", "artifacts");
  const unsignedPkg = path.join(artifactsDir, `agentos-${version}-macos-unsigned.pkg`);
  const finalPkg = path.join(artifactsDir, `agentos-${version}-macos.pkg`);
  const signingIdentity = process.env.AGENTOS_MACOS_SIGN_IDENTITY;
  const allowUnsigned = process.env.ALLOW_UNSIGNED_PACKAGE === "1";

  await fs.mkdir(artifactsDir, { recursive: true });
  await ensureCommand("pkgbuild");
  await run("pkgbuild", [
    "--root",
    rootPath,
    "--scripts",
    scriptsPath,
    "--identifier",
    "dev.agentos.cli",
    "--version",
    version,
    unsignedPkg
  ]);

  if (signingIdentity) {
    await ensureCommand("productsign");
    await run("productsign", ["--sign", signingIdentity, unsignedPkg, finalPkg]);
  } else if (allowUnsigned) {
    await fs.copyFile(unsignedPkg, finalPkg);
  } else {
    throw new Error("AGENTOS_MACOS_SIGN_IDENTITY is required unless ALLOW_UNSIGNED_PACKAGE=1.");
  }

  process.stdout.write(
    `${JSON.stringify({ platform: "darwin", version, packagePath: finalPkg, signed: Boolean(signingIdentity) }, null, 2)}\n`
  );
}

await main();
