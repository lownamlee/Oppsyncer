export type SyncDecision =
  | "empty"
  | "initialize-remote"
  | "adopt-remote"
  | "record-remote-baseline"
  | "bootstrap-blocked"
  | "remote-missing"
  | "idle"
  | "push-local"
  | "recover-and-adopt";

export interface SyncFacts {
  baselineSha: string | null;
  remoteSha: string | null;
  localEmpty: boolean;
  localEqualsBaseline: boolean;
  localEqualsRemote: boolean;
}

export function decideSyncAction(facts: SyncFacts): SyncDecision {
  const { baselineSha, remoteSha } = facts;

  if (!baselineSha) {
    if (!remoteSha) {
      return facts.localEmpty ? "empty" : "initialize-remote";
    }
    if (facts.localEmpty) return "adopt-remote";
    if (facts.localEqualsRemote) return "record-remote-baseline";
    return "bootstrap-blocked";
  }

  if (!remoteSha) return "remote-missing";
  if (facts.localEqualsRemote) {
    return remoteSha === baselineSha ? "idle" : "record-remote-baseline";
  }
  if (remoteSha === baselineSha) {
    return facts.localEqualsBaseline ? "idle" : "push-local";
  }
  return facts.localEqualsBaseline ? "adopt-remote" : "recover-and-adopt";
}
