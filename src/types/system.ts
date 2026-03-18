import type {
  ConnectorStatus,
  DraftRecord,
  TaskSnapshot,
  WatchRule
} from "./runtime-schema.js";
import type { LearningStatus, ProposalRecord } from "./learning.js";
import type { RuntimeVersionInfo } from "../version.js";
import type { SidecarHealthResult, SidecarPermissionsResult } from "./native-sidecar.js";

export interface DaemonInstallStatus {
  supported: boolean;
  mode: "launchd" | "task-scheduler" | "unsupported";
  installed: boolean;
  loaded?: boolean | null;
  label?: string | null;
  path?: string | null;
  command?: string | null;
}

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  port?: number | string;
  startedAt?: string | null;
  dataDir?: string;
  connectorCount?: number;
  livePackCount?: number;
  readyLivePackCount?: number;
  blockedLivePackCount?: number;
  watchCount?: number;
  enabledWatchCount?: number;
  degradedWatchCount?: number;
  pendingDraftCount?: number;
  pendingProposalCount?: number;
  recentErrors?: Array<{
    id: string;
    status: string;
    message: string;
    updatedAt: string;
  }>;
  install?: DaemonInstallStatus;
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
  readyLivePackCount: number;
  blockedLivePackCount: number;
  degradedWatchCount: number;
  pendingDraftCount: number;
  pendingProposalCount: number;
  awaitingApprovalWatchCount: number;
  backoffWatchCount: number;
  connectorCount: number;
  learning: LearningStatus;
  version: RuntimeVersionInfo;
  install: DaemonInstallStatus;
  recentErrors: Array<{
    id: string;
    status: string;
    message: string;
    updatedAt: string;
  }>;
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
  proposals?: ProposalRecord[];
  connectors?: ConnectorStatus[];
}

export interface SetupReport {
  ok: boolean;
  startedDaemon: boolean;
  daemon: DaemonStatus;
  doctor: DoctorReport;
  recommendedActions: string[];
}
