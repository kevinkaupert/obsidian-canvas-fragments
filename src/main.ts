import {
  App,
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  WorkspaceLeaf
} from "obsidian";

interface CanvasFragmentsSettings {
  fragmentsFolder: string;
  hubsFolder: string;
  autoBuildHubs: boolean;
  noteKinds: string[];
}

const DEFAULT_SETTINGS: CanvasFragmentsSettings = {
  fragmentsFolder: "Fragmente",
  hubsFolder: "wiki",
  autoBuildHubs: true,
  noteKinds: [
    "definition",
    "satz",
    "beweis",
    "beispiel",
    "gegenbeispiel",
    "bemerkung"
  ]
};

const KIND_SECTIONS: Record<string, string> = {
  definition: "Definition",
  satz: "Sätze",
  theorem: "Sätze",
  beweis: "Beweise",
  proof: "Beweise",
  beispiel: "Beispiele",
  example: "Beispiele",
  gegenbeispiel: "Gegenbeispiele",
  counterexample: "Gegenbeispiele",
  bemerkung: "Bemerkungen",
  remark: "Bemerkungen"
};

export default class CanvasFragmentsPlugin extends Plugin {
  settings: CanvasFragmentsSettings;

  async onload() {
    await this.loadSettings();

    // 1. Context Menu on Canvas Nodes
    this.registerEvent(
      this.app.workspace.on("canvas:node-menu", (menu: Menu, node: any) => {
        this.addCanvasMenuItems(menu, node);
      })
    );

    // 2. Command: File Active/Selected Card as Fragment
    this.addCommand({
      id: "file-card-as-fragment",
      name: "Ausgewählte Karte als Fragment ablegen",
      checkCallback: (checking: boolean) => {
        const canvas = this.getActiveCanvas();
        if (!canvas) return false;
        const selected = canvas.selection ? Array.from(canvas.selection.values()) : [];
        if (selected.length !== 1) return false;
        const node = selected[0] as any;
        if (node?.unknownData?.type !== "text") return false;
        if (checking) return true;
        this.fileCardAsFragment(canvas, node);
        return true;
      }
    });

    // 3. Command: Build/Update All Hub Notes
    this.addCommand({
      id: "build-hub-notes",
      name: "Hub Notes aktualisieren (hub build)",
      callback: async () => {
        await this.buildHubs();
      }
    });

    // 4. Editor Suggest for # Concept (Kind) Autocomplete
    this.registerEditorSuggest(new FragmentAutocompleteSuggest(this.app, this));

    // 5. Visual Status Indicators (Draft Kringel & Fragment Dots)
    this.registerInterval(
      window.setInterval(() => {
        this.updateCanvasBadges();
      }, 500)
    );

    // 6. Settings Tab
    this.addSettingTab(new CanvasFragmentsSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // --- Canvas & Node Helpers ---

  getActiveCanvas(): any {
    const activeLeaf = this.app.workspace.getActiveViewOfType(WorkspaceLeaf as any) as any;
    const view = this.app.workspace.getActiveViewOfType(this.app.workspace.activeEditor?.constructor as any) as any;
    const canvasView = this.app.workspace.getLeavesOfType("canvas").find(
      (l) => l.view === activeLeaf || l.view === view || (l.view as any)?.canvas
    );
    return (canvasView?.view as any)?.canvas || (view as any)?.canvas || (activeLeaf as any)?.canvas;
  }

  addCanvasMenuItems(menu: Menu, node: any) {
    const canvas = node?.canvas || this.getActiveCanvas();
    if (!canvas) return;

    const data = node.unknownData;
    if (data?.type === "text") {
      menu.addItem((item) => {
        item
          .setTitle("Als Fragment ablegen")
          .setIcon("archive")
          .onClick(async () => {
            await this.fileCardAsFragment(canvas, node);
          });
      });
    } else if (data?.type === "file" && data?.file?.startsWith(this.settings.fragmentsFolder + "/")) {
      menu.addItem((item) => {
        item
          .setTitle("Wieder als Textkarte")
          .setIcon("undo")
          .onClick(async () => {
            await this.unfileCardToText(canvas, node);
          });
      });
    }
  }

  // --- Fragment Filing ---

  async fileCardAsFragment(canvas: any, node: any) {
    const rawText: string = node.text || node.unknownData?.text || "";
    if (!rawText.trim()) {
      new Notice("Die Karte ist leer.");
      return;
    }

    const { title, kind, concept, body } = this.parseCardText(rawText);

    // Ensure Fragments folder exists
    await this.ensureFolder(this.settings.fragmentsFolder);

    const safeTitle = this.sanitizeFileName(`${concept} (${this.capitalize(kind)})`);
    let filePath = `${this.settings.fragmentsFolder}/${safeTitle}.md`;
    let counter = 1;
    while (await this.app.vault.adapter.exists(filePath)) {
      filePath = `${this.settings.fragmentsFolder}/${safeTitle} ${++counter}.md`;
    }

    const frontmatter = [
      "---",
      `title: "${concept} (${this.capitalize(kind)})"`,
      `type: ${kind.toLowerCase()}`,
      `concept:`,
      `  - "[[${concept}]]"`,
      "---",
      "",
      body
    ].join("\n");

    const createdFile = await this.app.vault.create(filePath, frontmatter);

    // Replace text node with file node on Canvas
    if (canvas && canvas.getData && canvas.setData) {
      const canvasData = canvas.getData();
      const nodeIndex = canvasData.nodes.findIndex((n: any) => n.id === node.id);
      if (nodeIndex !== -1) {
        canvasData.nodes[nodeIndex] = {
          id: node.id,
          type: "file",
          file: createdFile.path,
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
          color: node.color
        };
        canvas.setData(canvasData);
        canvas.requestSave?.();
      }
    }

    new Notice(`Fragment abgelegt: ${createdFile.basename}`);

    if (this.settings.autoBuildHubs) {
      await this.buildHubs(concept);
    }
  }

  async unfileCardToText(canvas: any, node: any) {
    const filePath: string = node.unknownData?.file || "";
    if (!filePath) return;

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;

    const content = await this.app.vault.read(file);
    // Strip frontmatter
    const body = content.replace(/^---[\s\S]*?---\n*/, "").trim();

    if (canvas && canvas.getData && canvas.setData) {
      const canvasData = canvas.getData();
      const nodeIndex = canvasData.nodes.findIndex((n: any) => n.id === node.id);
      if (nodeIndex !== -1) {
        canvasData.nodes[nodeIndex] = {
          id: node.id,
          type: "text",
          text: body,
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
          color: node.color
        };
        canvas.setData(canvasData);
        canvas.requestSave?.();
      }
    }

    new Notice(`Karte wieder als Text hergestellt.`);
  }

  parseCardText(rawText: string): { title: string; kind: string; concept: string; body: string } {
    const lines = rawText.split("\n");
    let firstLine = lines[0].trim();
    let bodyLines = lines.slice(1);

    // Check for '# Title (Kind)'
    const headingMatch = firstLine.match(/^#+\s*(.+?)\s*\(([^)]+)\)$/);
    if (headingMatch) {
      const concept = headingMatch[1].trim();
      const kind = headingMatch[2].trim().toLowerCase();
      return {
        title: `${concept} (${this.capitalize(kind)})`,
        concept,
        kind,
        body: bodyLines.join("\n").trim()
      };
    }

    // Check for 'Title (Kind)'
    const lineMatch = firstLine.match(/^(.+?)\s*\(([^)]+)\)$/);
    if (lineMatch) {
      const concept = lineMatch[1].trim();
      const kind = lineMatch[2].trim().toLowerCase();
      return {
        title: `${concept} (${this.capitalize(kind)})`,
        concept,
        kind,
        body: bodyLines.join("\n").trim()
      };
    }

    // Fallback: take first line as concept, default kind "bemerkung"
    const concept = firstLine.replace(/^#+\s*/, "").trim() || "Gedanke";
    return {
      title: `${concept} (Bemerkung)`,
      concept,
      kind: "bemerkung",
      body: rawText.trim()
    };
  }

  // --- Hub Synthesis (hub build) ---

  async buildHubs(targetConcept?: string) {
    const fragmentsFolder = this.settings.fragmentsFolder;
    const hubsFolder = this.settings.hubsFolder;

    await this.ensureFolder(hubsFolder);

    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(fragmentsFolder + "/"));
    const conceptGroups: Record<string, { file: TFile; type: string; title: string }[]> = {};

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!fm) continue;

      const type = (fm.type || "bemerkung").toLowerCase();
      const rawConcept = fm.concept;

      let concepts: string[] = [];
      if (Array.isArray(rawConcept)) {
        concepts = rawConcept.map((c) => String(c).replace(/^\[\[|\]\]$/g, "").trim());
      } else if (typeof rawConcept === "string") {
        concepts = [rawConcept.replace(/^\[\[|\]\]$/g, "").trim()];
      }

      if (concepts.length === 0) {
        // Fallback from filename: "Begriff (Art)"
        const match = file.basename.match(/^(.+?)\s*\(/);
        if (match) concepts = [match[1].trim()];
      }

      for (const c of concepts) {
        if (!c) continue;
        if (targetConcept && c.toLowerCase() !== targetConcept.toLowerCase()) continue;
        if (!conceptGroups[c]) conceptGroups[c] = [];
        conceptGroups[c].push({ file, type, title: fm.title || file.basename });
      }
    }

    const conceptsToBuild = Object.keys(conceptGroups);
    if (conceptsToBuild.length === 0) {
      if (targetConcept) {
        new Notice(`Keine Fragmente für Konzept '${targetConcept}' gefunden.`);
      } else {
        new Notice("Keine Fragmente zur Hub-Erstellung gefunden.");
      }
      return;
    }

    for (const concept of conceptsToBuild) {
      const fragments = conceptGroups[concept];
      const hubContent = this.generateHubMarkdown(concept, fragments);
      const hubPath = `${hubsFolder}/${this.sanitizeFileName(concept)}.md`;

      const existingFile = this.app.vault.getAbstractFileByPath(hubPath);
      if (existingFile instanceof TFile) {
        await this.app.vault.modify(existingFile, hubContent);
      } else {
        await this.app.vault.create(hubPath, hubContent);
      }
    }

    new Notice(
      targetConcept
        ? `Hub Note '${targetConcept}' aktualisiert.`
        : `Hub Notes aktualisiert: ${conceptsToBuild.length} Konzepte verarbeitet.`
    );
  }

  generateHubMarkdown(concept: string, fragments: { file: TFile; type: string; title: string }[]): string {
    const sections: Record<string, string[]> = {
      Definition: [],
      Sätze: [],
      Beweise: [],
      Beispiele: [],
      Gegenbeispiele: [],
      Bemerkungen: []
    };

    for (const item of fragments) {
      const sectionName = KIND_SECTIONS[item.type] || "Bemerkungen";
      if (!sections[sectionName]) sections[sectionName] = [];
      sections[sectionName].push(`![[${item.file.basename}]]`);
    }

    const lines: string[] = [`# ${concept}`, ""];

    for (const [heading, embeds] of Object.entries(sections)) {
      if (embeds.length > 0) {
        lines.push(`## ${heading}`);
        lines.push(embeds.join("\n\n"));
        lines.push("");
      }
    }

    return lines.join("\n").trim() + "\n";
  }

  // --- Status Badges (Draft Kringel & Fragment Dots) ---

  updateCanvasBadges() {
    const canvasLeaves = this.app.workspace.getLeavesOfType("canvas");
    for (const leaf of canvasLeaves) {
      const canvas = (leaf.view as any)?.canvas;
      if (!canvas || !canvas.nodes) continue;

      for (const [id, node] of canvas.nodes) {
        const el = node.nodeEl as HTMLElement;
        if (!el) continue;

        const data = node.unknownData;
        const isFragmentFile =
          data?.type === "file" && typeof data?.file === "string" && data.file.startsWith(this.settings.fragmentsFolder + "/");
        const isDraftText = data?.type === "text";

        // 1. Fragment Solid Badge
        let badge = el.querySelector(".canvas-fragment-badge") as HTMLElement;
        if (isFragmentFile) {
          if (!badge) {
            badge = el.createDiv({ cls: "canvas-fragment-badge" });
            badge.addEventListener("click", (e) => {
              e.stopPropagation();
              this.app.workspace.openLinkText(data.file, "", "tab");
            });
          }
          badge.title = `Fragment: ${data.file} (Klick öffnet im Nebentab)`;
        } else if (badge) {
          badge.remove();
        }

        // 2. Draft Hollow Dot
        if (isDraftText) {
          el.classList.add("canvas-fragment-draft");
        } else {
          el.classList.remove("canvas-fragment-draft");
        }
      }
    }
  }

  // --- Utility Functions ---

  async ensureFolder(path: string) {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (!existing) {
      await this.app.vault.createFolder(path);
    }
  }

  sanitizeFileName(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, " ").trim();
  }

  capitalize(str: string): string {
    if (!str) return "";
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

// --- Autocomplete Suggester: # Concept (Kind) ---

interface SuggestionItem {
  concept: string;
  kind: string;
  display: string;
}

class FragmentAutocompleteSuggest extends EditorSuggest<SuggestionItem> {
  plugin: CanvasFragmentsPlugin;

  constructor(app: App, plugin: CanvasFragmentsPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line);
    const sub = line.slice(0, cursor.ch);

    const match = sub.match(/#\s*([a-zA-Z0-9äöüÄÖÜß\-_ ]*)$/);
    if (!match) return null;

    return {
      start: { line: cursor.line, ch: sub.length - match[0].length },
      end: cursor,
      query: match[1]
    };
  }

  getSuggestions(context: EditorSuggestContext): SuggestionItem[] {
    const query = context.query.toLowerCase().trim();
    const kinds = this.plugin.settings.noteKinds;

    // Collect known concepts from wiki/ hubs and Fragmente/
    const concepts = new Set<string>();
    const hubFiles = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(this.plugin.settings.hubsFolder + "/"));
    for (const h of hubFiles) {
      concepts.add(h.basename);
    }

    const fragmentFiles = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(this.plugin.settings.fragmentsFolder + "/"));
    for (const f of fragmentFiles) {
      const match = f.basename.match(/^(.+?)\s*\(/);
      if (match) concepts.add(match[1].trim());
    }

    const suggestions: SuggestionItem[] = [];

    // If query matches an existing concept
    for (const concept of concepts) {
      for (const kind of kinds) {
        const item: SuggestionItem = {
          concept,
          kind,
          display: `# ${concept} (${this.plugin.capitalize(kind)})`
        };
        if (!query || concept.toLowerCase().includes(query) || kind.includes(query)) {
          suggestions.push(item);
        }
      }
    }

    // Also offer query directly as a new concept
    if (query && !concepts.has(query)) {
      for (const kind of kinds) {
        suggestions.push({
          concept: this.plugin.capitalize(query),
          kind,
          display: `# ${this.plugin.capitalize(query)} (${this.plugin.capitalize(kind)})`
        });
      }
    }

    return suggestions.slice(0, 15);
  }

  renderSuggestion(value: SuggestionItem, el: HTMLElement): void {
    const row = el.createDiv({ cls: "fragment-suggest-row" });
    row.createSpan({ text: `# ${value.concept} `, cls: "fragment-suggest-concept" });
    row.createSpan({ text: `(${this.plugin.capitalize(value.kind)})`, cls: "fragment-suggest-kind" });
  }

  selectSuggestion(value: SuggestionItem, evt: MouseEvent | KeyboardEvent): void {
    if (!this.context) return;
    const replacement = `# ${value.concept} (${this.plugin.capitalize(value.kind)})\n`;
    this.context.editor.replaceRange(replacement, this.context.start, this.context.end);
  }
}

// --- Settings Tab ---

class CanvasFragmentsSettingTab extends PluginSettingTab {
  plugin: CanvasFragmentsPlugin;

  constructor(app: App, plugin: CanvasFragmentsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Canvas Fragments Einstellungen" });

    new Setting(containerEl)
      .setName("Fragmente Ordner")
      .setDesc("Ordner, in dem abgelegte Notiz-Fragmente gespeichert werden.")
      .addText((text) =>
        text
          .setPlaceholder("Fragmente")
          .setValue(this.plugin.settings.fragmentsFolder)
          .onChange(async (value) => {
            this.plugin.settings.fragmentsFolder = value.trim() || "Fragmente";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Hubs Ordner")
      .setDesc("Ordner für die zusammenfassenden Konzept-Notizen (z. B. wiki).")
      .addText((text) =>
        text
          .setPlaceholder("wiki")
          .setValue(this.plugin.settings.hubsFolder)
          .onChange(async (value) => {
            this.plugin.settings.hubsFolder = value.trim() || "wiki";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Automatischer Hub-Build")
      .setDesc("Aktualisiert die zugehörige Hub Note automatisch direkt nach dem Ablegen eines Fragments.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoBuildHubs).onChange(async (value) => {
          this.plugin.settings.autoBuildHubs = value;
          await this.plugin.saveSettings();
        })
      );
  }
}
