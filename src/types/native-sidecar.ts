export interface SidecarRequest<TParams = Record<string, unknown>> {
  id: string;
  method: string;
  params: TParams;
}

export interface SidecarSuccess<TResult = Record<string, unknown>> {
  id: string;
  ok: true;
  result: TResult;
}

export interface SidecarFailure {
  id: string;
  ok: false;
  error: string;
}

export type SidecarResponse<TResult = Record<string, unknown>> = SidecarSuccess<TResult> | SidecarFailure;

export interface SidecarHealthResult {
  platform: string;
  appVersion: string;
  nativeProtocolVersion: number;
  helperAvailable: boolean;
  methods: string[];
}

export interface SidecarBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export interface SidecarOcrObservation {
  text: string;
  confidence: number;
  box: SidecarBounds;
}

export interface SidecarOcrResult {
  observations: SidecarOcrObservation[];
}

export interface SidecarFindTextResult {
  found: boolean;
  match?: SidecarOcrObservation;
  count: number;
}

export interface SidecarPermissionsResult {
  accessibility: boolean;
  screenRecording: boolean;
}

export interface SidecarWindowInfo {
  windowNumber: number;
  ownerName: string;
  windowName: string;
  ownerPID: number;
  layer: number;
  alpha: number;
  bounds: SidecarBounds;
}

export interface SidecarListWindowsResult {
  windows: SidecarWindowInfo[];
}

export interface SidecarAccessibilityWindowInfo {
  title: string;
  bounds: SidecarBounds | null;
}

export interface SidecarAccessibilityElementInfo {
  id: string;
  role: string;
  subrole?: string | null;
  title?: string | null;
  value?: string | null;
  description?: string | null;
  enabled?: boolean;
  focused?: boolean;
  actions?: string[];
  windowTitle?: string | null;
  bounds?: SidecarBounds | null;
}

export interface SidecarAccessibilitySnapshotResult {
  appName: string;
  windows: SidecarAccessibilityWindowInfo[];
  elements: SidecarAccessibilityElementInfo[];
}

export interface SidecarCaptureParams {
  filePath: string;
}

export interface SidecarAppParams {
  name: string;
}

export interface SidecarTypeParams {
  text: string;
}

export interface SidecarKeyPressParams {
  key: string;
  modifiers?: string[];
}

export interface SidecarPointParams {
  x: number;
  y: number;
}

export interface SidecarScrollParams {
  dx: number;
  dy: number;
}
