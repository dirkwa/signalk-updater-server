export type Channel = 'stable' | 'beta' | 'master' | 'dirkwa';

export interface Tag {
  name: string;
  channel: Channel;
  digest: string;
  /** ISO8601 timestamp from the GitHub Packages API (`updated_at`),
   *  or null when the join missed the tag (rate-limited, deleted,
   *  or never populated by the Packages API). The UI renders null
   *  as an em dash. Never fabricate a "now" timestamp here. */
  pushedAt: string | null;
  size?: number;
}

/** Tag plus a server-computed `isLocal` flag. Returned by GET /api/versions
 *  so the UI can render Pull vs Switch without a second roundtrip. */
export interface AnnotatedTag extends Tag {
  isLocal: boolean;
}

export interface ContainerSnapshot {
  /** OperatorIntent: the tag suffix from the Quadlet's `Image=` line
   *  (`latest`, `dirkwa`, `0.6.3`, etc.). NOT a reliable indicator of
   *  what version is actually running — the Quadlet can pin a floating
   *  ref. Use `version` for that. */
  tag: string;
  /** Image digest from dockerode (no longer surfaced in the UI; kept on
   *  the wire for backward compat with older webapps). */
  digest: string;
  /** RuntimeIdentity: the running engine's package.json version, when
   *  knowable. Resolved via `getRuntimeIdentity` (HTTP health probe →
   *  OCI image label → Quadlet tag if semver). Null when no source
   *  could answer (e.g. signalk-server image with no
   *  `org.opencontainers.image.version` label and a floating Quadlet
   *  tag). */
  version: string | null;
  /** OperatorIntent channel: which release stream the Quadlet's tag
   *  belongs to. Derived from the Quadlet tag via `classifyChannel`. */
  channel: Channel | 'unknown';
  state: 'running' | 'stopped' | 'starting' | 'unhealthy' | 'missing';
  startedAt?: string;
}

export interface CurrentState {
  signalkServer: ContainerSnapshot;
  updaterServer: ContainerSnapshot & {
    updateAvailable: boolean;
    availableTag?: string;
  };
  doctorServer: ContainerSnapshot;
  lastCheck: string;
}

export interface SwitchRequest {
  tag: string;
  skipBackup?: boolean;
  skipPluginCheck?: boolean;
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

export type DeviceKind = 'serial' | 'can' | 'bluetooth' | 'gpio';

export interface Device {
  kind: DeviceKind;
  id: string;
  label: string;
  metadata?: Record<string, string>;
  enabled: boolean;
}

export interface RedeployResult {
  ok: boolean;
  changedDevices: { added: Device[]; removed: Device[] };
  durationMs: number;
  error?: string;
}

export interface SelfUpdateRequest {
  tag?: string;
}

/** GET /api/doctor/state — the updater's view of what the doctor container
 *  is running vs. what's available on GHCR. The doctor never serves this
 *  itself; the updater owns the GHCR check + Quadlet-rewrite path. */
export interface DoctorState {
  currentTag: string;
  availableTag?: string;
  updateAvailable: boolean;
}

/** Single-engine slot inside the AvailableUpdates response. */
export interface UpdateInfo {
  currentTag: string;
  availableTag?: string;
  updateAvailable: boolean;
}

/** GET /api/updates/available — daily-refreshed snapshot of both peer
 *  engines' current + latest stable tag, plus the doctor's npm
 *  dependency-drift report. Powered by a server-side setInterval so the
 *  badge stays accurate even when no client is open. */
export interface AvailableUpdates {
  updater: UpdateInfo;
  doctor: UpdateInfo;
  /** Drift report fetched from signalk-doctor-server's GET /api/drift.
   *  Optional — omitted when the doctor is unreachable, when no scan has
   *  run yet, or when the doctor has no admin token to call signalk-server. */
  signalkDeps?: DriftReport;
  lastCheckedAt: string | null;
}

/** Mirror of the doctor's `DriftClassification` enum. */
export type DriftClassification =
  | 'up-to-date'
  | 'patch'
  | 'minor'
  | 'major'
  | 'prerelease'
  | 'unknown';

/** Single package row in the drift report. */
export interface DriftPackage {
  name: string;
  installed: string;
  /** null when we've never successfully fetched from npm. */
  latest: string | null;
  classification: DriftClassification;
  /** ISO timestamp of the most recent successful npm fetch, or null. */
  lastFetchedAt: string | null;
}

/** Mirror of the doctor's GET /api/drift payload. */
export interface DriftReport {
  /** The signalk-server image tag the report was computed against. Null
   *  when the doctor couldn't inspect the container at scan time. */
  signalkImageTag: string | null;
  /** ISO timestamp of the most recent scan attempt (success or failure). */
  lastScannedAt: string;
  /** ISO timestamp of the most recent scan that actually reached npm. */
  lastSuccessfulScanAt: string | null;
  /** True if the most recent scan reached npm for at least one package. */
  online: boolean;
  packages: DriftPackage[];
}

/** Persisted per-installation Versions-tab filter. Lives at
 *  ~/.signalk-updater/version-settings.json (under /data inside the
 *  container). Defaults to stable-only — beta and master rows stay
 *  hidden until the operator opts in. */
export interface VersionSettings {
  showBeta: boolean;
  showMaster: boolean;
}

/** Locally-pulled signalk-server image, as enumerated by dockerode.
 *  The tag field strips the registry+repo prefix; size is the layered
 *  on-disk size dockerode reports. */
export interface LocalImage {
  /** Just the tag suffix after the final `:`, e.g. "0.6.0" or "master-ab12cd". */
  tag: string;
  /** Image id digest (sha256:...). */
  digest: string;
  /** Container-runtime "Created" timestamp; ISO 8601. */
  created: string;
  /** Sum of layer sizes reported by dockerode in bytes. */
  size: number;
}

export interface LocalImagesResponse {
  images: LocalImage[];
  totalSize: number;
}

/** Coarse stage the in-flight version switch is in. Mirrored verbatim in
 *  webapp/src/types.ts. See `src/switch-progress-broker.ts` for the
 *  publisher and `GET /api/versions/switch/stream` for the SSE
 *  endpoint that emits these. */
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

/** One SSE message on the switch progress stream. */
export interface SwitchProgressEvent {
  stage: SwitchStage;
  message?: string;
  to?: string;
  from?: string;
  error?: string;
  /** ISO 8601 timestamp the event was published. */
  at: string;
}

export type RuntimeKind = 'podman' | 'docker' | 'unknown';

export interface HealthResponse {
  ok: boolean;
  runtime: RuntimeKind;
  socketPath?: string;
  uptimeSeconds: number;
  /** Engine container's own package.json version, surfaced so a
   *  user's screenshot can be traced to a specific release. */
  version: string;
}
