// Webapp mirror of the engine's REST shapes. Hand-rolled rather than
// importing from src/ so the webapp build doesn't pick up Node-only
// imports along with the types.
//
// Drift policy: this file MUST stay structurally equivalent to
// src/types.ts. Field names, optionality, and string literal unions
// have to match exactly. Cosmetic differences are intentional:
//   - UpdaterSnapshot is extracted as an interface here instead of
//     the inline intersection in src/types.ts (same shape, easier
//     to spread/Pick from React props).
//   - ContainerState is named here instead of inlined (same union).
// If you change a server-side type, change this file in the same PR.

export type ContainerState = 'running' | 'stopped' | 'starting' | 'unhealthy' | 'missing';

export interface ContainerSnapshot {
  tag: string;
  digest: string;
  state: ContainerState;
  startedAt?: string;
}

export interface UpdaterSnapshot extends ContainerSnapshot {
  updateAvailable: boolean;
  availableTag?: string;
}

export interface CurrentState {
  signalkServer: ContainerSnapshot;
  updaterServer: UpdaterSnapshot;
  doctorServer: ContainerSnapshot;
  lastCheck: string;
}

export type RuntimeKind = 'podman' | 'docker' | 'unknown';

export interface HealthResponse {
  ok: boolean;
  runtime: RuntimeKind;
  socketPath?: string;
  uptimeSeconds: number;
  version: string;
}

export interface SelfState {
  currentTag: string;
  availableTag?: string;
  updateAvailable: boolean;
}

// Mirror of the doctor's "what's running and what's available" view,
// computed by the updater because it owns the GHCR check + the
// Quadlet-rewrite path for the doctor's container.
export interface DoctorState {
  currentTag: string;
  availableTag?: string;
  updateAvailable: boolean;
}

export interface UpdateInfo {
  currentTag: string;
  availableTag?: string;
  updateAvailable: boolean;
}

// Mirror of the server-side AvailableUpdates type — the daily GHCR
// snapshot for both peer engines, plus the doctor's npm dependency-drift
// report. Drives the App-level "N updates available" badge so a user
// sitting on Logs or Versions still sees the notification.
export interface AvailableUpdates {
  updater: UpdateInfo;
  doctor: UpdateInfo;
  signalkDeps?: DriftReport;
  lastCheckedAt: string | null;
}

export type DriftClassification =
  | 'up-to-date'
  | 'patch'
  | 'minor'
  | 'major'
  | 'prerelease'
  | 'unknown';

export interface DriftPackage {
  name: string;
  installed: string;
  latest: string | null;
  classification: DriftClassification;
  lastFetchedAt: string | null;
}

// Mirror of the doctor's GET /api/drift payload. Omitted etag here
// (server-side only — webapp never sends conditional GETs).
export interface DriftReport {
  signalkImageTag: string | null;
  lastScannedAt: string;
  lastSuccessfulScanAt: string | null;
  online: boolean;
  packages: DriftPackage[];
}

export type Channel = 'stable' | 'beta' | 'master' | 'dirkwa';

export interface Tag {
  name: string;
  channel: Channel;
  digest: string;
  pushedAt: string;
  size?: number;
}

/** Tag plus a server-computed isLocal flag. The /api/versions response
 *  carries AnnotatedTag rows; the UI uses isLocal to render Pull vs
 *  Switch without a second roundtrip. */
export interface AnnotatedTag extends Tag {
  isLocal: boolean;
}

export interface VersionsResponse {
  cachedAt: string;
  channels: Record<Channel, AnnotatedTag[]>;
}

export interface VersionSettings {
  showBeta: boolean;
  showMaster: boolean;
}

export interface LocalImage {
  tag: string;
  digest: string;
  created: string;
  size: number;
}

export interface LocalImagesResponse {
  images: LocalImage[];
  totalSize: number;
}

export type SwitchStage =
  | 'idle'
  | 'pulling'
  | 'trial'
  | 'rewriting-quadlet'
  | 'daemon-reload'
  | 'restarting'
  | 'health-poll'
  | 'rolling-back'
  | 'complete'
  | 'failed';

export interface SwitchProgressEvent {
  stage: SwitchStage;
  message?: string;
  to?: string;
  from?: string;
  error?: string;
  at: string;
}

export interface SwitchResult {
  ok: boolean;
  from: string;
  to: string;
  durationMs: number;
  hooksRun: string[];
  rolledBack?: boolean;
  error?: string;
  logsRef?: string;
}
