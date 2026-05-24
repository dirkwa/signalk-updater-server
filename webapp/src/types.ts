// Webapp mirror of the engine's REST shapes. Hand-rolled rather than
// importing from src/ so the webapp build doesn't pick up Node-only
// imports along with the types. Keep in sync with src/types.ts.

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
