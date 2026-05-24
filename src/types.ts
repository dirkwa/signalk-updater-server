export type Channel = 'stable' | 'beta' | 'master' | 'dirkwa';

export interface Tag {
  name: string;
  channel: Channel;
  digest: string;
  pushedAt: string;
  size?: number;
}

export interface ContainerSnapshot {
  tag: string;
  digest: string;
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
 *  engines' current + latest stable tag. Powered by a server-side
 *  setInterval so the badge stays accurate even when no client is open. */
export interface AvailableUpdates {
  updater: UpdateInfo;
  doctor: UpdateInfo;
  lastCheckedAt: string | null;
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
