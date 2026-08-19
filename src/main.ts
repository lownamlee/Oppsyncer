import {
  Notice,
  Platform,
  Plugin,
  TAbstractFile,
  TFile,
} from "obsidian";
import {
  normalizeData,
  ObSyncerData,
  SyncOutcome,
  SyncTrigger,
  SyncUiStatus,
} from "./model";
import ObSyncerSettingsTab from "./settings/tab";
import { settingsAreConfigured } from "./settings/settings";
import SyncEngine from "./sync/sync-engine";

export default class ObSyncerPlugin extends Plugin {
  private static readonly LOCAL_INVENTORY_INTERVAL_MS = 2 * 60 * 1000;
  data!: ObSyncerData;
  private engine!: SyncEngine;
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
  private dirtyPaths = new Map<string, number>();
  private localGeneration = 0;
  private lastLocalInventoryAt = 0;
  private fullInventoryRequested = true;

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
      getLocalGeneration: () => this.localGeneration,
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
    if (restartPoller) this.fullInventoryRequested = true;
    this.configureStatusBar();
    this.updateConfiguredStatus();
  }

  async testConnection(): Promise<void> {
    try {
      const repository = await this.engine.testConnection();
      new Notice(`Oppsyncer connected to ${repository}.`);
    } catch (error) {
      new Notice(`Oppsyncer connection failed: ${messageOf(error)}`, 0);
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
      new Notice("Oppsyncer has no recovery branch yet.");
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
      this.localGeneration++;
      if (file instanceof TFile) {
        this.dirtyPaths.set(file.path, this.localGeneration);
      } else {
        this.fullInventoryRequested = true;
      }
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
        this.localGeneration++;
        if (file instanceof TFile) {
          if (this.engine.isIncluded(oldPath)) {
            this.dirtyPaths.set(oldPath, this.localGeneration);
          }
          if (this.engine.isIncluded(file.path)) {
            this.dirtyPaths.set(file.path, this.localGeneration);
          }
        } else {
          this.fullInventoryRequested = true;
        }
        this.scheduleEditSync();
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        if (
          document.visibilityState === "visible" &&
          this.data.settings.autoSync &&
          settingsAreConfigured(this.data.settings)
        ) {
          void this.requestSync("file-open");
        }
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
      if (Platform.isDesktopApp || document.visibilityState === "visible") {
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
      if (trigger === "manual") new Notice("Configure Oppsyncer first.");
      return;
    }

    try {
      const generationAtStart = this.localGeneration;
      const capturedDirty = new Map(this.dirtyPaths);
      const inventoryDue =
        Date.now() - this.lastLocalInventoryAt >=
        ObSyncerPlugin.LOCAL_INVENTORY_INTERVAL_MS;
      const scanAll =
        trigger === "startup" ||
        trigger === "foreground" ||
        trigger === "manual" ||
        this.fullInventoryRequested ||
        inventoryDue;
      let remoteHeadWasChecked = false;
      let remoteHead: string | null = null;

      if (
        !scanAll &&
        capturedDirty.size === 0 &&
        (trigger === "poll" || trigger === "file-open")
      ) {
        const remoteCheck = await this.engine.checkRemoteHead();
        remoteHeadWasChecked = true;
        remoteHead = remoteCheck.head;
        if (!remoteCheck.changed) {
          this.lastReportedError = "";
          this.setStatus("idle", "Remote branch unchanged");
          return;
        }
      }

      this.setStatus("syncing", `Running ${trigger} synchronization`);
      const outcome = await this.engine.sync({
        dirtyPaths: scanAll ? undefined : [...capturedDirty.keys()],
        forceHash: trigger === "manual",
        remoteHead,
        remoteHeadWasChecked,
      });
      this.clearCapturedDirty(capturedDirty);
      if (scanAll) {
        this.lastLocalInventoryAt = Date.now();
        this.fullInventoryRequested = this.localGeneration !== generationAtStart;
      }
      this.lastReportedError = "";
      this.handleOutcome(outcome, trigger);
    } catch (error) {
      const message = messageOf(error);
      this.setStatus("error", message);
      if (trigger === "manual" || message !== this.lastReportedError) {
        new Notice(`Oppsyncer: ${message}`, trigger === "manual" ? 0 : 8000);
      }
      this.lastReportedError = message;
    }
  }

  private clearCapturedDirty(captured: Map<string, number>): void {
    for (const [path, generation] of captured) {
      if (this.dirtyPaths.get(path) === generation) {
        this.dirtyPaths.delete(path);
      }
    }
  }

  private handleOutcome(outcome: SyncOutcome, trigger: SyncTrigger): void {
    if (outcome.kind === "recovered" && outcome.recoveryRef) {
      this.setStatus("recovery", `Recovered local work to ${outcome.recoveryRef}`);
      new Notice(
        `Oppsyncer kept the remote winner. Your local version is safe on ${outcome.recoveryRef}.`,
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
      new Notice(`Oppsyncer: ${detail[outcome.kind]}.`);
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
      unconfigured: "Oppsyncer: setup",
      paused: "Oppsyncer: paused",
      idle: "Oppsyncer: synced",
      pending: "Oppsyncer: pending",
      syncing: "Oppsyncer: syncing…",
      recovery: "Oppsyncer: recovered",
      error: "Oppsyncer: error",
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
