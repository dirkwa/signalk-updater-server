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

export type Channel = 'stable' | 'beta' | 'master' | 'dirkwa';

export interface Tag {
  name: string;
  channel: Channel;
  digest: string;
  pushedAt: string;
  size?: number;
}

export interface VersionsResponse {
  cachedAt: string;
  channels: Record<Channel, Tag[]>;
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
