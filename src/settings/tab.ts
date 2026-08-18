import { App, PluginSettingTab, Setting } from "obsidian";
import ObSyncerPlugin from "../main";

export default class ObSyncerSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ObSyncerPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "ObSyncer" });
    containerEl.createEl("p", {
      text: "The first device that advances the remote wins. If another device has stale local edits, ObSyncer saves them to a recovery branch before adopting the remote.",
    });

    containerEl.createEl("h3", { text: "GitHub repository" });
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

    containerEl.createEl("h3", { text: "Synchronization" });
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
        "One glob per line. .obsidian/**, .git/**, .trash/** and OS metadata are always excluded.",
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

    containerEl.createEl("h3", { text: "Safety" });
    containerEl.createEl("p", {
      text: "ObSyncer never force-updates main and never replaces dirty local content until a recovery branch is created and verified. It cannot sync while a mobile operating system has suspended Obsidian.",
    });
  }
}
