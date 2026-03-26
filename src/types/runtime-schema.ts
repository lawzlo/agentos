export interface TaskSpec {
  goal: string;
  doneCondition?: string;
  preferredSurface?: "auto" | "browser" | "desktop";
  workspaceName?: string | null;
  skillName?: string | null;
  executionMode?: "planned" | "autonomous";
  triggerSource?: string;
  priority?: "low" | "normal" | "high";
  permissions?: {
    allowAdvancedActions?: boolean;
    allowShell?: boolean;
    automationPolicy?: "allow" | "draft_only" | "confirm_required" | "blocked";
    [key: string]: unknown;
  };
  inputs?: Record<string, unknown>;
  steps?: RuntimeStep[];
  autonomy?: {
    maxSteps?: number;
    enabled?: boolean;
    surface?: "browser" | "desktop";
  };
  saveSkillAs?: string | null;
  saveWatchAs?: Record<string, unknown> | null;
}

export type TaskStatus =
  | "queued"
  | "planning"
  | "running"
  | "verifying"
  | "paused"
  | "takeover"
  | "blocked"
  | "failed"
  | "completed"
  | "interrupted";

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
  screenTextBlocks: ScreenTextBlock[];
  interactionCandidates: InteractionCandidate[];
  visibleText: string;
  recentActions: RecentAction[];
  summary: string | null;
  timestamp: string;
}

export interface BrowserNavigationPolicy {
  allowSameTabNavigation?: boolean;
  allowNewTabs?: boolean;
  allowCrossOriginNavigation?: boolean;
}

export interface BrowserExecutionInput {
  instruction: string;
  startUrl?: string;
  actions?: string[];
  successCriteria?: string;
  verificationSchema?: Record<string, unknown> | null;
  maxSteps: number;
  navigationPolicy?: BrowserNavigationPolicy;
  timeoutMs?: number;
  variables?: Record<string, unknown>;
}

export interface BrowserBlocker {
  kind:
    | "signin_required"
    | "verification_required"
    | "session_expired"
    | "manual_intervention"
    | "page_unavailable"
    | "runtime_unavailable";
  detail: string;
  suggestedAction?: string | null;
}

export interface BrowserExecutionResult {
  status: "completed" | "blocked" | "failed";
  finalUrl: string;
  blockers: BrowserBlocker[];
  extractedResult?: unknown;
  verification?: Record<string, unknown> | null;
  observeResult?: unknown;
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

export interface RuntimeControlState {
  mode: "agent" | "paused" | "takeover" | "stopped";
  reason: string | null;
  source: string;
  updatedAt: string;
}

export interface TraceEventRecord {
  id: string;
  traceId: string;
  taskId: string;
  role: string;
  type: string;
  stepId: string | null;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface TraceRecord {
  id: string;
  taskId: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  plan: RuntimeStep[];
  output: Record<string, unknown> | null;
}

export interface TraceSnapshot extends TraceRecord {
  events: TraceEventRecord[];
}

export interface TaskRecord {
  id: string;
  goal: string;
  status: TaskStatus;
  priority: "low" | "normal" | "high";
  triggerSource: string;
  deadline: string | null;
  preferredSurface: "auto" | "browser" | "desktop";
  workspaceId: string | null;
  traceId: string | null;
  taskSpec: TaskSpec | Record<string, unknown>;
  plan: RuntimeStep[];
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskSnapshot extends TaskRecord {
  trace: TraceSnapshot | null;
  artifacts: ArtifactReference[];
  runtimeControl: RuntimeControlState | null;
}

export interface EventRecord {
  id: string;
  type: string;
  source: string;
  taskId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface WorkspaceRecord {
  id: string;
  taskId: string;
  rootPath: string;
  profilePath: string;
  downloadsPath: string;
  artifactsPath: string;
  scratchPath: string;
  createdAt: string;
}

export interface WorkspaceProfile {
  id: string;
  name: string;
  rootPath: string;
  profilePath: string;
  downloadsPath: string;
  artifactsPath: string;
  scratchPath: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ScreenTextBlock {
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
  health?: WatchHealth;
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

export interface WatchHealth {
  state: "healthy" | "warning" | "degraded" | "disabled";
  failureCount: number;
  retryAfter: string | null;
  retryAfterMs: number | null;
  activeTaskId: string | null;
  activeDraftId: string | null;
  lastHandledFingerprint: string | null;
  summary: string | null;
  attentionKind?: "login" | "verification" | "access_denied" | "session_expired" | null;
  attentionDetail?: string | null;
  attentionAction?: string | null;
  threadKey?: string | null;
  threadFailureCount?: number;
  threadCooldownUntil?: string | null;
  replyLeaseExpiresAt?: string | null;
  threadEscalatedAt?: string | null;
  lastInboundMessageId?: string | null;
  lastInboundReceivedAt?: string | null;
  lastAgentActionAt?: string | null;
  scanStage?:
    | "prepare_workspace"
    | "activate_pack"
    | "observe_inbox"
    | "detect_items"
    | "extract_context"
    | "draft_reply"
    | "create_task"
    | null;
  scanStageStatus?: "running" | "failed" | null;
  scanStageStartedAt?: string | null;
  scanStageTimeoutMs?: number | null;
  runnerType?: SurfaceRunnerType | null;
  scene?: SceneType | null;
  selectedTarget?: string | null;
  lastSkipReasons?: string[];
  lastRecoveryAction?: SurfaceRecoveryAction | null;
  surfaceHealth?: SurfaceHealthState | null;
  surfaceHealthCooldownUntil?: string | null;
  budgetStatus?: RunBudgetStatus | null;
  usageSummary?: UsageSummary | null;
  artifactUsage?: ArtifactUsage | null;
  storageGuard?: StorageGuardStatus | null;
}

export type SurfaceRunnerType = "browser_native" | "desktop_ax" | "desktop_vlm";

export type SceneType = "list" | "thread" | "foreign_view" | "signin" | "verification" | "unknown";

export type SurfaceRecoveryAction = "recover_to_list" | "complete_signin" | "complete_verification" | "takeover" | "none";

export type SurfaceHealthState = "healthy" | "busy" | "cooldown" | "unsupported" | "setup_required";

export type RunBudgetStatus = "ok" | "exceeded" | "paused";

export interface UsageSummary {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
}

export interface ArtifactUsage {
  workspaceArtifactBytes: number;
  workspaceArtifactLimitBytes: number;
  globalArtifactBytes: number | null;
  globalArtifactLimitBytes: number | null;
  prunedFiles: number;
}

export interface StorageGuardStatus {
  active: boolean;
  freeBytes: number | null;
  usedPercent: number | null;
  maximumUsedPercent: number;
}

export interface ConversationThreadState {
  threadKey: string;
  lastMessageId: string | null;
  lastInboundMessageId: string | null;
  lastInboundReceivedAt: string | null;
  lastSender: string | null;
  lastDirection: "inbound" | "outbound" | "unknown";
  lastAgentActionAt: string | null;
  lastAgentTaskId: string | null;
  replyLeaseExpiresAt: number | null;
  failureCount: number;
  cooldownUntil: number | null;
  escalatedAt: string | null;
  updatedAt: string | null;
}

export interface WatchQuietHours {
  startHour: number;
  endHour: number;
}

export type ReplyPolicyMode =
  | "pack_default"
  | "auto_send"
  | "draft_first"
  | "prefill_first"
  | "approve_once_then_auto"
  | "blocked";
export type LivePackCategory = "conversation" | "documents" | "files" | "generic";
export type LivePackCapability =
  | "watch_events"
  | "thread_context"
  | "draft_reply"
  | "send_reply"
  | "auto_send_replies"
  | "candidate_review"
  | "document_edit"
  | "file_upload"
  | "file_download";

export interface LivePackHealthCheck {
  id: string;
  label: string;
  status: "ready" | "warning" | "blocked";
  detail?: string | null;
}

export interface WatchGovernance {
  approvalMode?: "auto" | "draft_only" | "confirm_required" | "blocked";
  replyPolicy?: ReplyPolicyMode;
  replyApprovalWindowMs?: number;
  cooldownMs?: number;
  maxAutoActionsPerDay?: number;
  maxConsecutiveFailures?: number;
  quietHours?: WatchQuietHours | null;
}

export interface WatchProfile {
  triggerTexts?: string[];
  anchors?: Array<{ text: string; role: string }>;
  actionTemplate?: RuntimeStep[];
  recoveryHints?: string[];
  executionMode?: "planned" | "autonomous";
  governance?: WatchGovernance;
  liveHints?: {
    openTargetQuery?: string | null;
    composeTargetQuery?: string | null;
    sendTargetQuery?: string | null;
    waitText?: string | null;
    dynamicInputKeys?: string[];
  };
  metadata?: Record<string, unknown>;
}

export interface WatchDetection {
  fingerprint?: string;
  summary?: string | null;
  goal?: string | null;
  text?: string | null;
  inputs?: Record<string, unknown>;
  taskSpec?: Partial<TaskSpec> | null;
  replyText?: string | null;
  context?: string[];
  metadata?: WatchDetectionMetadata;
}

export interface WatchDetectionMetadata extends Record<string, unknown> {
  threadKey?: string | null;
  replyThreadKey?: string | null;
  messageId?: string | null;
  sender?: string | null;
  direction?: "inbound" | "outbound" | "unknown";
  receivedAt?: string | null;
  requiresAttention?: boolean;
  openCandidate?: InteractionCandidate | Record<string, unknown> | null;
  surface?: "browser" | "desktop";
  skillName?: string | null;
  requiresManualIntervention?: boolean;
  manualInterventionKind?: "login" | "verification" | "access_denied" | "session_expired" | null;
  manualInterventionDetail?: string | null;
  manualInterventionAction?: string | null;
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

export interface RiskGateDecision {
  policy: "allow" | "draft_only" | "confirm_required" | "blocked";
  riskLevel: "normal" | "high";
  reasons: string[];
  action: "send" | "draft" | "prefill" | "block";
}

export interface DraftRecord {
  id: string;
  watchRuleId: string | null;
  livePack: string | null;
  status: "pending" | "approved" | "rejected" | "expired";
  summary: string | null;
  replyText: string | null;
  fingerprint: string | null;
  taskSpec: TaskSpec;
  detection: Record<string, unknown>;
  riskDecision: RiskGateDecision;
  metadata: Record<string, unknown>;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
}

export interface StepVerification {
  ok: boolean;
  details: Record<string, unknown>;
}

export interface ExecutionStepResult {
  stepId: string;
  label: string;
  surface: string;
  action: string;
  result: unknown;
  checkpoint: Record<string, unknown> | null;
  verification: StepVerification | null;
}

export interface ExecutionSummary {
  outputs: Record<string, unknown>;
  stepResults: ExecutionStepResult[];
}

export interface VerificationCheck {
  stepId: string;
  ok: boolean;
  details: Record<string, unknown>;
}

export interface VerificationSummary {
  ok: boolean;
  confidence: number;
  checks: VerificationCheck[];
  outputs: Record<string, unknown>;
}

export interface GroundingFallback {
  targetId: string;
  confidence: number;
  target: InteractionCandidate;
}

export interface GroundingResult {
  targetId: string;
  resolutionMode: string;
  confidence: number;
  target: InteractionCandidate;
  fallbacks: GroundingFallback[];
}

export interface PlanDerivation {
  steps: RuntimeStep[];
  source: string;
  summary: string;
  skillName?: string;
}

export interface PlanPreview extends PlanDerivation {
  humanPlan: string[];
}

export interface AutonomyExecutionResult extends ExecutionSummary {
  verification: {
    ok: boolean;
    confidence: number;
    mode: "autonomous";
  };
  summary: string;
}

export interface LivePackInfo {
  name: string;
  family: "chat" | "mail" | "generic" | "docs" | "files";
  category: LivePackCategory;
  surface: "desktop" | "browser";
  supportsDrafts: boolean;
  supportsAutoSend: boolean;
  capabilities: LivePackCapability[];
  defaultReplyPolicy: Exclude<ReplyPolicyMode, "pack_default">;
  description: string;
  minimumLicenseTier?: "free" | "pro" | null;
  ready?: boolean;
  healthChecks?: LivePackHealthCheck[];
}

export interface ConnectorStatus {
  name: string;
  status?: string;
  [key: string]: unknown;
}

export interface SkillDefinition {
  id?: string;
  name: string;
  surfaceScope: "any" | "browser" | "desktop";
  triggerTerms: string[];
  anchors: Array<{ text: string; role: string }>;
  actionTemplate: RuntimeStep[];
  successCriteria: Record<string, unknown>[];
  recoveryHints: string[];
  metadata: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export type ControlAction =
  | "pause"
  | "resume"
  | "request_takeover"
  | "return_to_agent"
  | "stop";
