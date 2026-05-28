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

export type Channel = 'stable' | 'beta' | 'master' | 'dirkwa';

/** Channel union including the "couldn't read the Quadlet" answer.
 *  Mirrors `Channel | 'unknown'` on src/types.ts. */
export type ChannelOrUnknown = Channel | 'unknown';

export interface ContainerSnapshot {
  /** OperatorIntent: tag suffix from the Quadlet's `Image=` line. NOT
   *  the running version when the Quadlet pins a floating ref; use
   *  `version` for that. */
  tag: string;
  /** Image digest from dockerode. Kept on the wire for backward compat
   *  with the pre-runtime-version webapp; the new Dashboard renders
   *  `version`/`channel` instead. */
  digest: string;
  /** RuntimeIdentity: the running engine's reported version, when
   *  knowable. Resolved server-side via the health-probe → OCI-label →
   *  Quadlet-tag fallback in src/runtime-version.ts. Null when no
   *  source could answer (e.g. signalk-server with a floating tag and
   *  no OCI image label). */
  version: string | null;
  /** OperatorIntent channel derived from the Quadlet tag. */
  channel: ChannelOrUnknown;
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
  runtimeVersion?: string;
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

// Mirror of the doctor's GET /api/drift payload.
export interface DriftReport {
  signalkImageTag: string | null;
  lastScannedAt: string;
  lastSuccessfulScanAt: string | null;
  online: boolean;
  packages: DriftPackage[];
}

export interface Tag {
  name: string;
  channel: Channel;
  digest: string;
  /** ISO8601 image build timestamp (RFC3339), sourced server-side from
   *  the OCI image config blob's `created` field. Null when the lookup
   *  fails for any reason (deleted image, malformed config, etc.) — the
   *  UI renders null as an em dash. See src/types.ts for the canonical
   *  contract and the history of why this isn't sourced from GH Packages. */
  pushedAt: string | null;
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
