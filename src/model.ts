import { DEFAULT_SETTINGS, ObSyncerSettings } from "./settings/settings";

export const DATA_SCHEMA_VERSION = 1;

export interface ObSyncerState {
  schemaVersion: number;
  deviceId: string;
  baselineCommitSha: string | null;
  baselineTreeSha: string | null;
  baselineFiles: Record<string, string>;
  lastSuccessfulSyncAt: number;
  lastRecoveryRef: string | null;
}

export interface ObSyncerData {
  settings: ObSyncerSettings;
  state: ObSyncerState;
}

export interface LocalFileState {
  path: string;
  sha: string;
  size: number;
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
    baselineCommitSha: null,
    baselineTreeSha: null,
    baselineFiles: {},
    lastSuccessfulSyncAt: 0,
    lastRecoveryRef: null,
  };
}

export function normalizeData(
  raw: Partial<ObSyncerData> | null | undefined,
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
    baselineCommitSha: candidate.baselineCommitSha || null,
    baselineTreeSha: candidate.baselineTreeSha || null,
    baselineFiles:
      candidate.baselineFiles && typeof candidate.baselineFiles === "object"
        ? candidate.baselineFiles
        : {},
    lastRecoveryRef: candidate.lastRecoveryRef || null,
  };

  return { settings, state };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}
