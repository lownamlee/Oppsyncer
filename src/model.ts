import { DEFAULT_SETTINGS, ObSyncerSettings } from "./settings/settings";

export const DATA_SCHEMA_VERSION = 3;

export interface ObSyncerState {
  schemaVersion: number;
  deviceId: string;
  vaultId: string | null;
  vaultIdentityBlobSha: string | null;
  baselineCommitSha: string | null;
  baselineTreeSha: string | null;
  baselineFiles: Record<string, string>;
  localFiles: Record<string, LocalFileState>;
  lastSuccessfulSyncAt: number;
  lastRecoveryRef: string | null;
}

export interface ObSyncerData {
  settings: ObSyncerSettings;
  state: ObSyncerState;
}

export interface RawObSyncerData {
  settings?: Partial<ObSyncerSettings>;
  state?: Partial<ObSyncerState>;
}

export interface LocalFileState {
  path: string;
  sha: string;
  size: number;
  mtime: number;
}

export interface LocalSnapshot {
  files: Record<string, LocalFileState>;
}

export interface RemoteFileState {
  path: string;
  mode: string;
  type: "blob";
  sha: string;
  size: number;
}

export interface RemoteSnapshot {
  commitSha: string;
  treeSha: string;
  files: Record<string, RemoteFileState>;
}

export type SyncTrigger =
  | "startup"
  | "foreground"
  | "background"
  | "file-open"
  | "edit"
  | "poll"
  | "manual";

export type SyncOutcomeKind =
  | "idle"
  | "empty"
  | "initialized"
  | "pushed"
  | "pulled"
  | "baseline-recorded"
  | "recovered";

export interface SyncOutcome {
  kind: SyncOutcomeKind;
  recoveryRef?: string;
  detail?: string;
}

export type SyncUiStatus =
  | "unconfigured"
  | "paused"
  | "idle"
  | "pending"
  | "syncing"
  | "recovery"
  | "error";

function createDeviceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function defaultState(): ObSyncerState {
  return {
    schemaVersion: DATA_SCHEMA_VERSION,
    deviceId: createDeviceId(),
    vaultId: null,
    vaultIdentityBlobSha: null,
    baselineCommitSha: null,
    baselineTreeSha: null,
    baselineFiles: {},
    localFiles: {},
    lastSuccessfulSyncAt: 0,
    lastRecoveryRef: null,
  };
}

export function normalizeData(
  raw: RawObSyncerData | null | undefined,
  defaultDeviceName: string,
): ObSyncerData {
  const settings: ObSyncerSettings = {
    ...DEFAULT_SETTINGS,
    ...(raw?.settings ?? {}),
  };
  settings.deviceName = settings.deviceName.trim() || defaultDeviceName;
  settings.syncObsidianConfig = settings.syncObsidianConfig === true;
  settings.editDebounceSeconds = clamp(
    Number(settings.editDebounceSeconds) || DEFAULT_SETTINGS.editDebounceSeconds,
    1,
    30,
  );
  settings.remotePollSeconds = clamp(
    Number(settings.remotePollSeconds) || DEFAULT_SETTINGS.remotePollSeconds,
    5,
    300,
  );
  settings.excludedPatterns = Array.isArray(settings.excludedPatterns)
    ? settings.excludedPatterns.map((item) => String(item).trim()).filter(Boolean)
    : [];

  const initialState = defaultState();
  const candidate: Partial<ObSyncerState> = raw?.state ?? {};
  const state: ObSyncerState = {
    ...initialState,
    ...candidate,
    schemaVersion: DATA_SCHEMA_VERSION,
    deviceId: String(candidate.deviceId || initialState.deviceId),
    vaultId: candidate.vaultId ? String(candidate.vaultId) : null,
    vaultIdentityBlobSha: candidate.vaultIdentityBlobSha
      ? String(candidate.vaultIdentityBlobSha)
      : null,
    baselineCommitSha: candidate.baselineCommitSha || null,
    baselineTreeSha: candidate.baselineTreeSha || null,
    baselineFiles:
      candidate.baselineFiles && typeof candidate.baselineFiles === "object"
        ? candidate.baselineFiles
        : {},
    localFiles: normalizeLocalFiles(candidate.localFiles),
    lastRecoveryRef: candidate.lastRecoveryRef || null,
  };

  return { settings, state };
}

function normalizeLocalFiles(
  candidate: unknown,
): Record<string, LocalFileState> {
  if (!candidate || typeof candidate !== "object") return {};
  const result: Record<string, LocalFileState> = {};
  for (const [path, raw] of Object.entries(candidate)) {
    if (!raw || typeof raw !== "object") continue;
    const value = raw as Partial<LocalFileState>;
    if (!value.sha || !Number.isFinite(value.size) || !Number.isFinite(value.mtime)) {
      continue;
    }
    result[path] = {
      path,
      sha: String(value.sha),
      size: Number(value.size),
      mtime: Number(value.mtime),
    };
  }
  return result;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}
