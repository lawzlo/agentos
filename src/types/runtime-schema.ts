export interface TaskSpec {
  goal: string;
  preferredSurface?: "auto" | "browser" | "desktop";
  workspaceName?: string | null;
  skillName?: string | null;
  executionMode?: "planned" | "autonomous";
  triggerSource?: string;
  priority?: "low" | "normal" | "high";
  inputs?: Record<string, unknown>;
  steps?: RuntimeStep[];
}

export interface RuntimeStep {
  id?: string;
  label?: string;
  surface?: "browser" | "desktop";
  action: string;
  params?: Record<string, unknown>;
  expect?: Record<string, unknown> | null;
  saveAs?: string | null;
  checkpoint?: boolean;
}

export interface WorldState {
  version: number;
  surface: "browser" | "desktop";
  workspaceId: string;
  appContext: Record<string, unknown> | null;
  capture: ArtifactReference | null;
  ocrBlocks: OcrBlock[];
  interactionCandidates: InteractionCandidate[];
  visibleText: string;
  recentActions: RecentAction[];
  summary: string | null;
  timestamp: string;
}

export interface ArtifactReference {
  id: string;
  taskId: string;
  traceId: string | null;
  kind: string;
  label: string;
  path: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface OcrBlock {
  id: string;
  text: string;
  confidence: number;
  bounds: Bounds;
  source?: string;
}

export interface InteractionCandidate {
  id: string;
  surface: "browser" | "desktop";
  kind: string;
  text: string;
  role: string | null;
  bounds: Bounds;
  confidence: number;
  sourceHints: Record<string, unknown>;
  isInteractive: boolean;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export interface RecentAction {
  label?: string;
  action?: string;
  surface?: string;
  result?: unknown;
}

export interface WatchRule {
  id: string;
  goal: string;
  enabled: boolean;
  status: string;
  preferredSurface: "browser" | "desktop";
  workspaceName: string | null;
  skillName: string | null;
  appTarget: string | null;
  livePack: string;
  pollIntervalMs: number;
  watchProfile: WatchProfile;
  taskInputs: Record<string, unknown>;
  dedupeState: Record<string, unknown>;
  lastObservedAt: string | null;
  lastTriggeredAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WatchProfile {
  triggerTexts?: string[];
  anchors?: Array<{ text: string; role: string }>;
  actionTemplate?: RuntimeStep[];
  recoveryHints?: string[];
  executionMode?: "planned" | "autonomous";
  liveHints?: {
    openTargetQuery?: string | null;
    composeTargetQuery?: string | null;
    sendTargetQuery?: string | null;
    waitText?: string | null;
    dynamicInputKeys?: string[];
  };
  metadata?: Record<string, unknown>;
}

export interface TeachTemplateInput {
  key: string;
  label: string;
  defaultValue: string;
}

export interface TeachRecording {
  version: number;
  recordedAt: string;
  actionTemplate: RuntimeStep[];
  anchors: Array<{ text: string; role: string }>;
  templateInputs: TeachTemplateInput[];
  triggerTerms: string[];
  recoveryHints: string[];
  summary: {
    sourceGoal: string;
    stepCount: number;
    surfaces: string[];
    manualTeachStepsCount: number;
    manualCorrectionsCount: number;
  };
}

export interface SkillDefinition {
  name: string;
  surfaceScope: "any" | "browser" | "desktop";
  triggerTerms: string[];
  anchors: Array<{ text: string; role: string }>;
  actionTemplate: RuntimeStep[];
  successCriteria: Record<string, unknown>[];
  recoveryHints: string[];
  metadata: Record<string, unknown>;
}

export type ControlAction =
  | "pause"
  | "resume"
  | "request_takeover"
  | "return_to_agent"
  | "stop";
