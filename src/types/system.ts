import type {
  ConnectorStatus,
  DraftRecord,
  TaskSnapshot,
  WatchRule
} from "./runtime-schema.js";
import type { RuntimeVersionInfo } from "../version.js";
import type { SidecarHealthResult, SidecarPermissionsResult } from "./native-sidecar.js";

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  port?: number | string;
  startedAt?: string | null;
  dataDir?: string;
  connectorCount?: number;
  watchCount?: number;
  enabledWatchCount?: number;
  [key: string]: unknown;
}

export interface NativeDiagnostics {
  available: boolean;
  compatible: boolean;
  reason?: string;
  health?: SidecarHealthResult;
  permissions?: SidecarPermissionsResult | null;
}

export interface DoctorReport {
  ok: boolean;
  warnings: string[];
  browserExecutable: string | null;
  modelConfigured: boolean;
  livePackCount: number;
  degradedWatchCount: number;
  pendingDraftCount: number;
  connectorCount: number;
  version: RuntimeVersionInfo;
  store: {
    schemaVersion: number;
    compatible: boolean;
  };
  native: NativeDiagnostics;
}

export interface DoctorBundle {
  bundleId: string;
  bundlePath: string;
  doctor: DoctorReport;
  copiedLogs: string[];
  manifest: {
    files: string[];
  };
}

export interface DoctorBundleSnapshot {
  createdAt: string;
  doctor: DoctorReport;
  daemon: DaemonStatus;
  daemonRuntime: {
    running: boolean;
    state: Record<string, unknown> | null;
  };
  install: {
    dataDir: string;
    daemonDir: string;
    dbPath: string;
    inboxDir: string;
    browserExecutable: string | null;
  };
}

export interface DiagnosticBundleSource {
  doctor: DoctorReport;
  daemon: DaemonStatus;
  tasks: TaskSnapshot[];
  watches: WatchRule[];
  drafts: DraftRecord[];
  connectors?: ConnectorStatus[];
}
