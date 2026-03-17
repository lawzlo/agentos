import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = process.cwd();
const UPGRADE_CODE = "D0C2A6B6-3BA0-4D0E-8F6D-3A42E4E90C01";

function wixId(input) {
  return input.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z_])/, "_$1");
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      shell: true
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

async function listFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

function buildDirectoryTree(appDir, currentDir, componentRefs) {
  const relative = path.relative(appDir, currentDir);
  const directoryId = relative ? `DIR_${wixId(relative)}` : "INSTALLFOLDER";
  return fs.readdir(currentDir, { withFileTypes: true }).then(async (entries) => {
    const childDirectories = [];
    const components = [];
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        childDirectories.push(await buildDirectoryTree(appDir, fullPath, componentRefs));
        continue;
      }
      const relativeFile = path.relative(appDir, fullPath);
      const componentId = `CMP_${wixId(relativeFile)}`;
      const fileId = `FILE_${wixId(relativeFile)}`;
      componentRefs.push(componentId);
      components.push(`
        <Component Id="${componentId}" Guid="*">
          <File Id="${fileId}" Source="${xmlEscape(fullPath)}" KeyPath="yes" />
        </Component>`);
    }

    const directoryChildren = [...childDirectories, ...components].join("\n");
    if (!relative) {
      return `
      <StandardDirectory Id="ProgramFilesFolder">
        <Directory Id="INSTALLFOLDER" Name="AgentOS">
${directoryChildren}
        </Directory>
      </StandardDirectory>`;
    }

    return `
        <Directory Id="${directoryId}" Name="${xmlEscape(path.basename(currentDir))}">
${directoryChildren}
        </Directory>`;
  });
}

async function main() {
  await run(process.execPath, ["scripts/package-release.mjs", "--platform", "win32"]);

  const pkg = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
  const version = pkg.version;
  const stageDir = path.join(rootDir, "release", "staging", "win32");
  const appDir = path.join(stageDir, "app");
  const artifactsDir = path.join(rootDir, "release", "artifacts");
  const wxsPath = path.join(stageDir, "AgentOS.wxs");
  const msiPath = path.join(artifactsDir, `agentos-${version}-windows.msi`);
  const allowUnsigned = process.env.ALLOW_UNSIGNED_PACKAGE === "1";
  const pfxPath = process.env.AGENTOS_WINDOWS_SIGN_PFX_PATH;
  const pfxBase64 = process.env.AGENTOS_WINDOWS_SIGN_PFX_BASE64;
  const pfxPassword = process.env.AGENTOS_WINDOWS_SIGN_PFX_PASSWORD;

  await fs.mkdir(artifactsDir, { recursive: true });
  const componentRefs = [];
  const directoryTree = await buildDirectoryTree(appDir, appDir, componentRefs);
  const featureRefs = componentRefs
    .map((componentId) => `      <ComponentRef Id="${componentId}" />`)
    .join("\n");

  const wxs = `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="AgentOS" Manufacturer="AgentOS" Version="${version}" UpgradeCode="${UPGRADE_CODE}">
    <MajorUpgrade DowngradeErrorMessage="A newer version of AgentOS is already installed." />
    <MediaTemplate />
${directoryTree}
    <Feature Id="MainFeature" Title="AgentOS" Level="1">
${featureRefs}
    </Feature>
  </Package>
</Wix>
`;
  await fs.writeFile(wxsPath, wxs, "utf8");

  await run("wix", ["build", wxsPath, "-o", msiPath]);

  let signed = false;
  let resolvedPfxPath = pfxPath ?? null;
  if (!resolvedPfxPath && pfxBase64) {
    resolvedPfxPath = path.join(stageDir, "signing.pfx");
    await fs.writeFile(resolvedPfxPath, Buffer.from(pfxBase64, "base64"));
  }

  if (resolvedPfxPath) {
    await execFileAsync("where", ["signtool"]);
    await run("signtool", [
      "sign",
      "/fd",
      "SHA256",
      "/f",
      resolvedPfxPath,
      "/p",
      pfxPassword ?? "",
      msiPath
    ]);
    signed = true;
  } else if (!allowUnsigned) {
    throw new Error(
      "Windows signing requires AGENTOS_WINDOWS_SIGN_PFX_PATH or AGENTOS_WINDOWS_SIGN_PFX_BASE64 unless ALLOW_UNSIGNED_PACKAGE=1."
    );
  }

  process.stdout.write(
    `${JSON.stringify({ platform: "win32", version, packagePath: msiPath, signed }, null, 2)}\n`
  );
}

await main();
