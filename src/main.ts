import {
  Notice,
  Platform,
  Plugin,
  TAbstractFile,
} from "obsidian";
import {
  normalizeData,
  ObSyncerData,
  ObSyncerState,
  SyncOutcome,
  SyncTrigger,
  SyncUiStatus,
} from "./model";
import ObSyncerSettingsTab from "./settings/tab";
import { settingsAreConfigured } from "./settings/settings";
import SyncEngine from "./sync/sync-engine";

export default class ObSyncerPlugin extends Plugin {
  data: ObSyncerData;
  private engine: SyncEngine;
  private statusBar: HTMLElement | null = null;
  private status: SyncUiStatus = "unconfigured";
  private statusDetail = "";
  private editTimer: number | null = null;
  private pollTimer: number | null = null;
  private currentSync: Promise<void> | null = null;
  private rerunRequested = false;
  private rerunTrigger: SyncTrigger = "poll";
  private applyingRemote = false;
  private persistQueue: Promise<void> = Promise.resolve();
  private lastReportedError = "";

  async onload(): Promise<void> {
    const raw = (await this.loadData()) as Partial<ObSyncerData> | null;
    this.data = normalizeData(raw, Platform.isMobile ? "mobile" : "desktop");
    await this.persistData();

    this.engine = new SyncEngine({
      vault: this.app.vault,
      trashFile: (file) => this.app.fileManager.trashFile(file),
      getSettings: () => this.data.settings,
      getState: () => this.data.state,
      saveState: async (state) => {
        this.data.state = state;
        await this.persistData();
      },
      setApplyingRemote: (applying) => {
        this.applyingRemote = applying;
      },
    });

    this.addSettingTab(new ObSyncerSettingsTab(this.app, this));
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      icon: "refresh-cw",
      callback: () => void this.requestSync("manual"),
    });
    this.addCommand({
      id: "open-last-recovery",
      name: "Open last recovery branch",
      icon: "history",
      checkCallback: (checking) => {
        if (!this.data.state.lastRecoveryRef) return false;
        if (!checking) this.openLastRecoveryBranch();
        return true;
      },
    });

    this.app.workspace.onLayoutReady(() => {
      this.registerVaultEvents();
      this.configureStatusBar();
      this.restartPoller();
      this.updateConfiguredStatus();
      if (this.data.settings.autoSync && settingsAreConfigured(this.data.settings)) {
        void this.requestSync("startup");
      }
    });

    this.registerDomEvent(document, "visibilitychange", () => {
      if (!this.data.settings.autoSync || !settingsAreConfigured(this.data.settings)) {
        return;
      }
      if (document.visibilityState === "visible") {
        void this.requestSync("foreground");
      } else if (this.editTimer !== null) {
        window.clearTimeout(this.editTimer);
        this.editTimer = null;
        void this.requestSync("background");
      }
    });
  }

  onunload(): void {
    if (this.editTimer !== null) window.clearTimeout(this.editTimer);
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
  }

  async savePluginData(restartPoller = false): Promise<void> {
    await this.persistData();
    if (restartPoller) this.restartPoller();
    this.configureStatusBar();
    this.updateConfiguredStatus();
  }

  async testConnection(): Promise<void> {
    try {
      const repository = await this.engine.testConnection();
      new Notice(`ObSyncer connected to ${repository}.`);
    } catch (error) {
      new Notice(`ObSyncer connection failed: ${messageOf(error)}`, 0);
    }
  }

  async syncNow(): Promise<void> {
    await this.requestSync("manual");
  }

  getRecoveryUrl(): string | null {
    const recovery = this.data.state.lastRecoveryRef;
    if (!recovery || !settingsAreConfigured(this.data.settings)) return null;
    const { githubOwner, githubRepo } = this.data.settings;
    return `https://github.com/${encodeURIComponent(githubOwner)}/${encodeURIComponent(
      githubRepo,
    )}/tree/${recovery.split("/").map(encodeURIComponent).join("/")}`;
  }

  openLastRecoveryBranch(): void {
    const url = this.getRecoveryUrl();
    if (!url) {
      new Notice("ObSyncer has no recovery branch yet.");
      return;
    }
    window.open(url, "_blank");
  }

  private registerVaultEvents(): void {
    const schedule = (file: TAbstractFile): void => {
      if (this.applyingRemote) {
        this.rerunRequested = true;
        this.rerunTrigger = "edit";
        return;
      }
      if (!this.engine.isIncluded(file.path)) return;
      this.scheduleEditSync();
    };
    this.registerEvent(this.app.vault.on("create", schedule));
    this.registerEvent(this.app.vault.on("modify", schedule));
    this.registerEvent(this.app.vault.on("delete", schedule));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (
          !this.applyingRemote &&
          !this.engine.isIncluded(file.path) &&
          !this.engine.isIncluded(oldPath)
        ) {
          return;
        }
        if (this.applyingRemote) {
          this.rerunRequested = true;
          this.rerunTrigger = "edit";
          return;
        }
        this.scheduleEditSync();
      }),
    );
  }

  private scheduleEditSync(): void {
    if (!this.data.settings.autoSync || !settingsAreConfigured(this.data.settings)) {
      return;
    }
    if (this.editTimer !== null) window.clearTimeout(this.editTimer);
    this.setStatus("pending", "Waiting for editing to stop");
    this.editTimer = window.setTimeout(() => {
      this.editTimer = null;
      void this.requestSync("edit");
    }, this.data.settings.editDebounceSeconds * 1000);
  }

  private restartPoller(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (!this.data.settings.autoSync || !settingsAreConfigured(this.data.settings)) {
      return;
    }
    this.pollTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void this.requestSync("poll");
      }
    }, this.data.settings.remotePollSeconds * 1000);
    this.registerInterval(this.pollTimer);
  }

  private requestSync(trigger: SyncTrigger): Promise<void> {
    if (this.currentSync) {
      this.rerunRequested = true;
      this.rerunTrigger = trigger;
      return this.currentSync;
    }
    this.currentSync = this.runSyncLoop(trigger).finally(() => {
      this.currentSync = null;
    });
    return this.currentSync;
  }

  private async runSyncLoop(initialTrigger: SyncTrigger): Promise<void> {
    let trigger = initialTrigger;
    do {
      this.rerunRequested = false;
      await this.performSync(trigger);
      trigger = this.rerunTrigger;
    } while (this.rerunRequested);
  }

  private async performSync(trigger: SyncTrigger): Promise<void> {
    if (!settingsAreConfigured(this.data.settings)) {
      this.setStatus("unconfigured", "Configure GitHub access in settings");
      if (trigger === "manual") new Notice("Configure ObSyncer first.");
      return;
    }

    this.setStatus("syncing", `Running ${trigger} synchronization`);
    try {
      const outcome = await this.engine.sync(trigger);
      this.lastReportedError = "";
      this.handleOutcome(outcome, trigger);
    } catch (error) {
      const message = messageOf(error);
      this.setStatus("error", message);
      if (trigger === "manual" || message !== this.lastReportedError) {
        new Notice(`ObSyncer: ${message}`, trigger === "manual" ? 0 : 8000);
      }
      this.lastReportedError = message;
    }
  }

  private handleOutcome(outcome: SyncOutcome, trigger: SyncTrigger): void {
    if (outcome.kind === "recovered" && outcome.recoveryRef) {
      this.setStatus("recovery", `Recovered local work to ${outcome.recoveryRef}`);
      new Notice(
        `ObSyncer kept the remote winner. Your local version is safe on ${outcome.recoveryRef}.`,
        0,
      );
      return;
    }

    const detail: Record<SyncOutcome["kind"], string> = {
      idle: "Up to date",
      empty: outcome.detail ?? "Nothing to synchronize",
      initialized: "Remote repository initialized",
      pushed: "Local changes uploaded",
      pulled: "Remote changes downloaded",
      "baseline-recorded": "Baseline updated",
      recovered: "Recovery completed",
    };
    this.setStatus("idle", detail[outcome.kind]);
    if (trigger === "manual" || outcome.kind === "initialized") {
      new Notice(`ObSyncer: ${detail[outcome.kind]}.`);
    }
  }

  private configureStatusBar(): void {
    if (!this.data.settings.showStatusBar) {
      this.statusBar?.remove();
      this.statusBar = null;
      return;
    }
    if (!this.statusBar) {
      this.statusBar = this.addStatusBarItem();
      this.statusBar.addEventListener("click", () => void this.requestSync("manual"));
    }
    this.renderStatus();
  }

  private updateConfiguredStatus(): void {
    if (!settingsAreConfigured(this.data.settings)) {
      this.setStatus("unconfigured", "Configure GitHub access in settings");
    } else if (!this.data.settings.autoSync) {
      this.setStatus("paused", "Automatic synchronization is paused");
    } else if (this.status === "unconfigured" || this.status === "paused") {
      this.setStatus("idle", "Ready");
    }
  }

  private setStatus(status: SyncUiStatus, detail: string): void {
    this.status = status;
    this.statusDetail = detail;
    this.renderStatus();
  }

  private renderStatus(): void {
    if (!this.statusBar) return;
    const labels: Record<SyncUiStatus, string> = {
      unconfigured: "ObSyncer: setup",
      paused: "ObSyncer: paused",
      idle: "ObSyncer: synced",
      pending: "ObSyncer: pending",
      syncing: "ObSyncer: syncing…",
      recovery: "ObSyncer: recovered",
      error: "ObSyncer: error",
    };
    this.statusBar.setText(labels[this.status]);
    this.statusBar.setAttribute("aria-label", this.statusDetail);
    this.statusBar.setAttribute("title", this.statusDetail);
  }

  private persistData(): Promise<void> {
    this.persistQueue = this.persistQueue
      .catch(() => undefined)
      .then(() => this.saveData(this.data));
    return this.persistQueue;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
