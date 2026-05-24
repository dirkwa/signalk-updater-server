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
