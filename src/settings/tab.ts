import {
  App,
  PluginSettingTab,
  Setting,
  type SettingDefinitionItem,
} from "obsidian";
import ObSyncerPlugin from "../main";
import type { ObSyncerSettings } from "./settings";

type SettingKey = keyof ObSyncerSettings;

export default class ObSyncerSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ObSyncerPlugin) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
    const configDir = this.app.vault.configDir;
    const recovery = this.plugin.data.state.lastRecoveryRef;

    return [
      {
        name: "Synchronization strategy",
        desc: "The first device that advances the remote wins. If another device has stale local edits, Oppsyncer saves them to a recovery branch before adopting the remote.",
      },
      {
        type: "group",
        heading: "GitHub repository",
        items: [
          {
            name: "Fine-grained access token",
            desc: "Limit the token to this private vault repository with Contents: Read and write.",
            render: (setting) => {
              setting.addText((text) => {
                text.inputEl.type = "password";
                text
                  .setPlaceholder("github_pat_…")
                  .setValue(this.plugin.data.settings.githubToken)
                  .onChange(async (value) => {
                    this.plugin.data.settings.githubToken = value.trim();
                    await this.plugin.savePluginData(true);
                  });
              });
            },
          },
          {
            name: "Repository owner",
            desc: "Your GitHub username or organization.",
            control: {
              type: "text",
              key: "githubOwner",
              placeholder: "lownamlee",
            },
          },
          {
            name: "Repository name",
            desc: "The private repository containing the vault.",
            control: {
              type: "text",
              key: "githubRepo",
              placeholder: "obsidian-vault",
            },
          },
          {
            name: "Branch",
            desc: "The coordinated vault branch. Use main for a new empty repository.",
            control: {
              type: "text",
              key: "githubBranch",
              placeholder: "main",
            },
          },
          {
            name: "Test connection",
            desc: "Checks repository access without changing any files or Git references.",
            render: (setting) => {
              setting.addButton((button) =>
                button
                  .setButtonText("Test")
                  .onClick(async () => this.plugin.testConnection()),
              );
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Synchronization",
        items: [
          {
            name: "Device name",
            desc: "Used in commits and recovery branch names.",
            control: { type: "text", key: "deviceName" },
          },
          {
            name: "Automatic synchronization",
            desc: "Sync after edits and poll the remote while Obsidian is active.",
            control: { type: "toggle", key: "autoSync" },
          },
          {
            name: "Sync Obsidian configuration",
            desc: `Sync safe files under the vault's ${configDir} folder. Device workspace state, Oppsyncer credentials/state, caches, legacy sync metadata, and SQLite temporary files remain excluded.`,
            control: { type: "toggle", key: "syncObsidianConfig" },
          },
          {
            name: "Edit debounce",
            desc: "Seconds to wait after the last local edit before syncing.",
            control: {
              type: "slider",
              key: "editDebounceSeconds",
              min: 1,
              max: 30,
              step: 1,
              displayFormat: (value) => `${value} s`,
            },
          },
          {
            name: "Remote polling",
            desc: "Seconds between checks while Obsidian is in the foreground.",
            control: {
              type: "slider",
              key: "remotePollSeconds",
              min: 5,
              max: 300,
              step: 5,
              displayFormat: (value) => `${value} s`,
            },
          },
          {
            name: "Additional exclusions",
            desc: "One glob per line. Credentials, volatile Obsidian state, Git control files, trash, and OS metadata are always excluded.",
            control: {
              type: "textarea",
              key: "excludedPatterns",
              placeholder: "Private/**",
              rows: 6,
            },
          },
          {
            name: "Show status bar",
            desc: "Click the status item to run an immediate synchronization.",
            control: { type: "toggle", key: "showStatusBar" },
          },
          {
            name: "Sync now",
            desc: "Run the same guarded state machine used by automatic synchronization.",
            render: (setting) => {
              setting.addButton((button) =>
                button
                  .setButtonText("Sync now")
                  .setCta()
                  .onClick(async () => this.plugin.syncNow()),
              );
            },
          },
          {
            name: "Last recovery branch",
            desc: recovery ?? "No recovery branch has been created on this device.",
            render: (setting) => {
              setting.addButton((button) =>
                button
                  .setButtonText("Open on GitHub")
                  .setDisabled(!recovery)
                  .onClick(() => this.plugin.openLastRecoveryBranch()),
              );
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Safety",
        items: [
          {
            name: "Recovery guarantees",
            desc: "Oppsyncer never force-updates main, never synchronizes its token/state file, and never replaces dirty local content until a recovery branch is created and verified. It cannot sync while a mobile operating system has suspended Obsidian.",
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    if (!isSettingKey(key, this.plugin.data.settings)) return undefined;
    if (key === "excludedPatterns") {
      return this.plugin.data.settings.excludedPatterns.join("\n");
    }
    return this.plugin.data.settings[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.data.settings;
    if (!isSettingKey(key, settings)) return;
    let restartPoller = false;

    switch (key) {
      case "githubOwner":
      case "githubRepo":
        if (typeof value !== "string") return;
        settings[key] = value.trim();
        restartPoller = true;
        break;
      case "githubBranch":
        if (typeof value !== "string") return;
        settings.githubBranch = value.trim() || "main";
        restartPoller = true;
        break;
      case "deviceName":
        if (typeof value !== "string") return;
        settings.deviceName = value.trim() || "device";
        break;
      case "autoSync":
      case "syncObsidianConfig":
        if (typeof value !== "boolean") return;
        settings[key] = value;
        restartPoller = true;
        break;
      case "showStatusBar":
        if (typeof value !== "boolean") return;
        settings.showStatusBar = value;
        break;
      case "editDebounceSeconds":
        if (typeof value !== "number") return;
        settings.editDebounceSeconds = clamp(value, 1, 30);
        break;
      case "remotePollSeconds":
        if (typeof value !== "number") return;
        settings.remotePollSeconds = clamp(value, 5, 300);
        restartPoller = true;
        break;
      case "excludedPatterns":
        if (typeof value !== "string") return;
        settings.excludedPatterns = value
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        break;
      case "githubToken":
        return;
    }

    await this.plugin.savePluginData(restartPoller);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("p", {
      text: "The first device that advances the remote wins. If another device has stale local edits, Oppsyncer saves them to a recovery branch before adopting the remote.",
    });

    new Setting(containerEl).setName("GitHub repository").setHeading();
    new Setting(containerEl)
      .setName("Fine-grained access token")
      .setDesc("Limit the token to this private vault repository with Contents: Read and write.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("github_pat_…")
          .setValue(this.plugin.data.settings.githubToken)
          .onChange(async (value) => {
            this.plugin.data.settings.githubToken = value.trim();
            await this.plugin.savePluginData(true);
          });
      });

    new Setting(containerEl)
      .setName("Repository owner")
      .setDesc("Your GitHub username or organization.")
      .addText((text) =>
        text
          .setPlaceholder("lownamlee")
          .setValue(this.plugin.data.settings.githubOwner)
          .onChange(async (value) => {
            this.plugin.data.settings.githubOwner = value.trim();
            await this.plugin.savePluginData(true);
          }),
      );

    new Setting(containerEl)
      .setName("Repository name")
      .setDesc("The private repository containing the vault.")
      .addText((text) =>
        text
          .setPlaceholder("obsidian-vault")
          .setValue(this.plugin.data.settings.githubRepo)
          .onChange(async (value) => {
            this.plugin.data.settings.githubRepo = value.trim();
            await this.plugin.savePluginData(true);
          }),
      );

    new Setting(containerEl)
      .setName("Branch")
      .setDesc("The coordinated vault branch. Use main for a new empty repository.")
      .addText((text) =>
        text
          .setPlaceholder("main")
          .setValue(this.plugin.data.settings.githubBranch)
          .onChange(async (value) => {
            this.plugin.data.settings.githubBranch = value.trim() || "main";
            await this.plugin.savePluginData(true);
          }),
      );

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Checks repository access without changing any files or Git references.")
      .addButton((button) =>
        button.setButtonText("Test").onClick(async () => this.plugin.testConnection()),
      );

    new Setting(containerEl).setName("Synchronization").setHeading();
    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Used in commits and recovery branch names.")
      .addText((text) =>
        text
          .setValue(this.plugin.data.settings.deviceName)
          .onChange(async (value) => {
            this.plugin.data.settings.deviceName = value.trim() || "device";
            await this.plugin.savePluginData();
          }),
      );

    new Setting(containerEl)
      .setName("Automatic synchronization")
      .setDesc("Sync after edits and poll the remote while Obsidian is active.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.data.settings.autoSync)
          .onChange(async (value) => {
            this.plugin.data.settings.autoSync = value;
            await this.plugin.savePluginData(true);
          }),
      );

    new Setting(containerEl)
      .setName("Sync Obsidian configuration")
      .setDesc(
        `Sync safe files under the vault's ${this.app.vault.configDir} folder. Device workspace state, Oppsyncer credentials/state, caches, legacy sync metadata, and SQLite temporary files remain excluded.`,
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.data.settings.syncObsidianConfig)
          .onChange(async (value) => {
            this.plugin.data.settings.syncObsidianConfig = value;
            await this.plugin.savePluginData(true);
          }),
      );

    new Setting(containerEl)
      .setName("Edit debounce")
      .setDesc("Seconds to wait after the last local edit before syncing.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 30, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.data.settings.editDebounceSeconds)
          .onChange(async (value) => {
            this.plugin.data.settings.editDebounceSeconds = value;
            await this.plugin.savePluginData();
          }),
      );

    new Setting(containerEl)
      .setName("Remote polling")
      .setDesc("Seconds between checks while Obsidian is in the foreground.")
      .addSlider((slider) =>
        slider
          .setLimits(5, 300, 5)
          .setDynamicTooltip()
          .setValue(this.plugin.data.settings.remotePollSeconds)
          .onChange(async (value) => {
            this.plugin.data.settings.remotePollSeconds = value;
            await this.plugin.savePluginData(true);
          }),
      );

    new Setting(containerEl)
      .setName("Additional exclusions")
      .setDesc(
        "One glob per line. Credentials, volatile Obsidian state, Git control files, trash, and OS metadata are always excluded.",
      )
      .addTextArea((area) => {
        area.inputEl.rows = 6;
        area
          .setPlaceholder("Private/**")
          .setValue(this.plugin.data.settings.excludedPatterns.join("\n"))
          .onChange(async (value) => {
            this.plugin.data.settings.excludedPatterns = value
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean);
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName("Show status bar")
      .setDesc("Click the status item to run an immediate synchronization.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.data.settings.showStatusBar)
          .onChange(async (value) => {
            this.plugin.data.settings.showStatusBar = value;
            await this.plugin.savePluginData();
          }),
      );

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Run the same guarded state machine used by automatic synchronization.")
      .addButton((button) =>
        button.setButtonText("Sync now").setCta().onClick(async () => this.plugin.syncNow()),
      );

    const recovery = this.plugin.data.state.lastRecoveryRef;
    new Setting(containerEl)
      .setName("Last recovery branch")
      .setDesc(recovery ?? "No recovery branch has been created on this device.")
      .addButton((button) =>
        button
          .setButtonText("Open on GitHub")
          .setDisabled(!recovery)
          .onClick(() => this.plugin.openLastRecoveryBranch()),
      );

    new Setting(containerEl).setName("Safety").setHeading();
    containerEl.createEl("p", {
      text: "Oppsyncer never force-updates main, never synchronizes its token/state file, and never replaces dirty local content until a recovery branch is created and verified. It cannot sync while a mobile operating system has suspended Obsidian.",
    });
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function isSettingKey(key: string, settings: ObSyncerSettings): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(settings, key);
}
