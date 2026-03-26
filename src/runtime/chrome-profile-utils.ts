import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ChromeProfileInfo {
  directory: string;
  name: string;
}

export interface ChromeProfileSource {
  userDataDir: string;
  profileDirectory: string;
  profilePath: string;
  source: "explicit_profile" | "explicit_user_data_dir" | "system_last_used";
}

function normalizeDirectoryName(value: unknown): string {
  return String(value ?? "").trim();
}

function defaultChromeUserDataDir(): string | null {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Google", "Chrome");
    case "win32":
      return path.join(home, "AppData", "Local", "Google", "Chrome", "User Data");
    default:
      return path.join(home, ".config", "google-chrome");
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(targetPath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(targetPath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

interface ChromeLocalStateProfile {
  last_used?: string;
  last_active_profiles?: string[];
  info_cache?: Record<string, { name?: string }>;
}

export async function listChromeProfiles(userDataDir = defaultChromeUserDataDir()): Promise<ChromeProfileInfo[]> {
  const normalizedUserDataDir = String(userDataDir ?? "").trim();
  if (!normalizedUserDataDir) {
    return [];
  }

  const localState = await readJsonFile<{ profile?: ChromeLocalStateProfile }>(
    path.join(normalizedUserDataDir, "Local State")
  );
  const infoCache = localState?.profile?.info_cache ?? {};
  return Object.entries(infoCache)
    .map(([directory, info]) => ({
      directory,
      name: String(info?.name ?? directory).trim() || directory
    }))
    .sort((left, right) => left.directory.localeCompare(right.directory));
}

async function inferDefaultProfileDirectory(userDataDir: string): Promise<string | null> {
  const localState = await readJsonFile<{ profile?: ChromeLocalStateProfile }>(
    path.join(userDataDir, "Local State")
  );
  const profile = localState?.profile ?? {};
  const candidates = [
    normalizeDirectoryName(profile.last_used),
    normalizeDirectoryName(profile.last_active_profiles?.[0]),
    "Default"
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await pathExists(path.join(userDataDir, candidate))) {
      return candidate;
    }
  }

  const profiles = await listChromeProfiles(userDataDir);
  return profiles[0]?.directory ?? null;
}

export async function resolveChromeProfileSource(
  preferredPath?: string | null
): Promise<ChromeProfileSource | null> {
  const explicitPath = String(preferredPath ?? "").trim();
  if (explicitPath) {
    const normalizedExplicitPath = path.resolve(explicitPath);
    const explicitLocalStatePath = path.join(normalizedExplicitPath, "Local State");
    if (await pathExists(explicitLocalStatePath)) {
      const profileDirectory = await inferDefaultProfileDirectory(normalizedExplicitPath);
      if (!profileDirectory) {
        return null;
      }
      return {
        userDataDir: normalizedExplicitPath,
        profileDirectory,
        profilePath: path.join(normalizedExplicitPath, profileDirectory),
        source: "explicit_user_data_dir"
      };
    }

    const explicitParent = path.dirname(normalizedExplicitPath);
    if (await pathExists(path.join(explicitParent, "Local State"))) {
      return {
        userDataDir: explicitParent,
        profileDirectory: path.basename(normalizedExplicitPath),
        profilePath: normalizedExplicitPath,
        source: "explicit_profile"
      };
    }
  }

  const userDataDir = defaultChromeUserDataDir();
  if (!userDataDir || !(await pathExists(path.join(userDataDir, "Local State")))) {
    return null;
  }

  const profileDirectory = await inferDefaultProfileDirectory(userDataDir);
  if (!profileDirectory) {
    return null;
  }

  return {
    userDataDir,
    profileDirectory,
    profilePath: path.join(userDataDir, profileDirectory),
    source: "system_last_used"
  };
}

const CHROME_PROFILE_SESSION_ENTRIES = [
  "Account Web Data",
  "Cookies",
  "Cookies-journal",
  "Extension Cookies",
  "Extension Cookies-journal",
  "File System",
  "Local Storage",
  "Login Data",
  "Login Data For Account",
  "Network",
  "Preferences",
  "Secure Preferences",
  "Session Storage",
  "Sessions",
  "SharedStorage",
  "SharedStorage-wal",
  "Storage",
  "Top Sites",
  "Visited Links",
  "Web Data",
  "WebStorage"
];

function shouldCopyNestedChromeEntry(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  const baseName = path.basename(normalized);
  if (!normalized || normalized === ".") {
    return true;
  }

  return !(
    baseName === "SingletonLock"
    || baseName === "SingletonSocket"
    || baseName === "SingletonCookie"
    || baseName === "DevToolsActivePort"
    || baseName === "lockfile"
    || baseName === "LOCK"
  );
}

async function copyChromeProfileEntry(sourcePath: string, destinationPath: string): Promise<void> {
  if (!(await pathExists(sourcePath))) {
    return;
  }

  const stat = await fs.stat(sourcePath);
  if (stat.isDirectory()) {
    await fs.cp(sourcePath, destinationPath, {
      recursive: true,
      force: true,
      filter: (entry) => shouldCopyNestedChromeEntry(path.relative(sourcePath, entry))
    });
    return;
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.copyFile(sourcePath, destinationPath);
}

async function ensureCleanDirectory(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { recursive: true, force: true });
  await fs.mkdir(targetPath, { recursive: true });
}

export async function cloneChromeProfileToWorkspace({
  source,
  targetUserDataDir
}: {
  source: ChromeProfileSource;
  targetUserDataDir: string;
}): Promise<{
  userDataDir: string;
  profileDirectory: string;
  profilePath: string;
  copiedFrom: ChromeProfileSource;
}> {
  await ensureCleanDirectory(targetUserDataDir);

  const localStateSource = path.join(source.userDataDir, "Local State");
  if (await pathExists(localStateSource)) {
    await fs.copyFile(localStateSource, path.join(targetUserDataDir, "Local State"));
  }

  const targetProfilePath = path.join(targetUserDataDir, source.profileDirectory);
  await fs.mkdir(targetProfilePath, { recursive: true });
  for (const entryName of CHROME_PROFILE_SESSION_ENTRIES) {
    await copyChromeProfileEntry(
      path.join(source.profilePath, entryName),
      path.join(targetProfilePath, entryName)
    );
  }

  await fs.writeFile(
    path.join(targetUserDataDir, ".agentos-profile-source.json"),
    JSON.stringify(
      {
        copiedFrom: source.profilePath,
        profileDirectory: source.profileDirectory,
        source: source.source,
        copiedAt: new Date().toISOString()
      },
      null,
      2
    ),
    "utf8"
  );

  return {
    userDataDir: targetUserDataDir,
    profileDirectory: source.profileDirectory,
    profilePath: targetProfilePath,
    copiedFrom: source
  };
}
