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
    "Definition",
    "Axiom",
    "Satz",
    "Beweis",
    "Beispiel",
    "Gegenbeispiel",
    "Bemerkung",
    "Intuition",
    "Anwendung",
    "Übung",
    "Notation"
  ]
};

interface KindDef {
  type: string;
  name: string;
  aliases?: string[];
  hub_section?: string;
  color?: string;
}

interface HubLayoutSection {
  heading: string;
  subheading?: string;
  types?: string[];
  prerequisites?: boolean;
}

const DEFAULT_KINDS: KindDef[] = [
  { type: "definition", name: "Definition", hub_section: "Definition" },
  { type: "axiom", name: "Axiom", hub_section: "Axiome" },
  { type: "theorem", name: "Satz", aliases: ["Voraussetzung", "Behauptung"], hub_section: "Sätze" },
  { type: "proof", name: "Beweis", aliases: ["Beweisschritt"], hub_section: "Beweise" },
  { type: "example", name: "Beispiel", aliases: ["Beispiele"], hub_section: "Beispiele" },
  { type: "counterexample", name: "Gegenbeispiel", aliases: ["Gegenbeispiele"], hub_section: "Gegenbeispiele" },
  { type: "remark", name: "Bemerkung", aliases: ["Bemerkungen"], hub_section: "Bemerkungen" },
  { type: "intuition", name: "Intuition", aliases: ["Intuition und Motivation"] },
  { type: "application", name: "Anwendung", aliases: ["Anwendungen"] },
  { type: "exercise", name: "Übung", aliases: ["Übungen"] },
  { type: "related", name: "Verwandtes Konzept" },
  { type: "advanced", name: "Weiterführendes Konzept" },
  { type: "review", name: "Wissensüberprüfung" },
  { type: "question", name: "Offene Frage" },
  { type: "insight", name: "Persönliche Erkenntnis" },
  { type: "notation", name: "Notation" }
];

const DEFAULT_HUB_LAYOUT: HubLayoutSection[] = [
  { heading: "1. Intuition", types: ["intuition"] },
  { heading: "2. Formale Grundlagen", subheading: "Definitionen", types: ["definition", "axiom"] },
  { heading: "2. Formale Grundlagen", subheading: "Voraussetzungen und Notation", types: ["notation"] },
  { heading: "3. Beispiele und Gegenbeispiele", subheading: "Beispiele", types: ["example"] },
  { heading: "3. Beispiele und Gegenbeispiele", subheading: "Gegenbeispiele und Grenzfälle", types: ["counterexample"] },
  { heading: "4. Eigenschaften und Sätze", types: ["theorem"] },
  { heading: "5. Begründungen und Beweise", types: ["proof"] },
  { heading: "6. Anwendungen und Übungen", subheading: "Anwendungen", types: ["application"] },
  { heading: "6. Anwendungen und Übungen", subheading: "Übungen", types: ["exercise"] },
  { heading: "7. Mathematische Vernetzung", subheading: "Voraussetzungen", prerequisites: true },
  { heading: "7. Mathematische Vernetzung", subheading: "Verwandte Konzepte", types: ["related"] },
  { heading: "7. Mathematische Vernetzung", subheading: "Weiterführende Konzepte", types: ["advanced"] },
  { heading: "8. Wissensüberprüfung", types: ["review"] },
  { heading: "9. Offene Fragen und Wissenslücken", types: ["question"] },
  { heading: "10. Persönliche Erkenntnisse", types: ["insight"] }
];

const CROCKFORD32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function generateUlid(): string {
  let time = Date.now();
  let timeChars = "";
  for (let i = 9; i >= 0; i--) {
    const mod = time % 32;
    timeChars = CROCKFORD32[mod] + timeChars;
    time = (time - mod) / 32;
  }
  let randChars = "";
  for (let i = 0; i < 16; i++) {
    randChars += CROCKFORD32[Math.floor(Math.random() * 32)];
  }
  return timeChars + randChars;
}

export default class CanvasFragmentsPlugin extends Plugin {
  settings: CanvasFragmentsSettings;

  async onload() {
    await this.loadSettings();

    // 1. Context Menu on Canvas Nodes
    this.registerEvent(
      (this.app.workspace as any).on("canvas:node-menu", (menu: Menu, node: any) => {
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

  // --- KnowOS Config Helpers ---

  async loadKnowosConfig(): Promise<{ kinds: KindDef[]; layout: HubLayoutSection[] }> {
    let kinds = DEFAULT_KINDS;
    let layout = DEFAULT_HUB_LAYOUT;

    try {
      const knowosFile = this.app.vault.getAbstractFileByPath("knowos.json");
      if (knowosFile instanceof TFile) {
        const knowosJson = JSON.parse(await this.app.vault.cachedRead(knowosFile));
        if (typeof knowosJson?.note_kinds === "string") {
          const kindsFile = this.app.vault.getAbstractFileByPath(knowosJson.note_kinds);
          if (kindsFile instanceof TFile) {
            const parsed = JSON.parse(await this.app.vault.cachedRead(kindsFile));
            if (Array.isArray(parsed?.kinds)) kinds = parsed.kinds;
          }
        }
        if (typeof knowosJson?.hub_layout === "string") {
          const layoutFile = this.app.vault.getAbstractFileByPath(knowosJson.hub_layout);
          if (layoutFile instanceof TFile) {
            const parsed = JSON.parse(await this.app.vault.cachedRead(layoutFile));
            if (Array.isArray(parsed?.sections)) layout = parsed.sections;
          }
        }
      }
    } catch (e) {
      console.warn("[obsidian-canvas-fragments] Fallback to default knowos config:", e);
    }

    return { kinds, layout };
  }

  resolveKind(rawKind: string, kinds: KindDef[]): { typeKey: string; displayName: string } {
    const cleaned = rawKind.trim();
    const lower = cleaned.toLowerCase();

    for (const k of kinds) {
      if (k.type.toLowerCase() === lower || k.name.toLowerCase() === lower) {
        return { typeKey: k.type, displayName: k.name };
      }
      if (Array.isArray(k.aliases) && k.aliases.some((a) => a.toLowerCase() === lower)) {
        return { typeKey: k.type, displayName: cleaned };
      }
    }

    // Substring/prefix heuristics (e.g. "Bemerkung 2", "Intuition und Motivation", "Beispiel - ...")
    for (const k of kinds) {
      if (lower.startsWith(k.name.toLowerCase()) || lower.startsWith(k.type.toLowerCase())) {
        return { typeKey: k.type, displayName: cleaned };
      }
    }

    return { typeKey: "remark", displayName: cleaned || "Bemerkung" };
  }

  cleanConceptName(raw: string): string {
    let s = String(raw ?? "").trim();
    // Strip [[ and ]]
    s = s.replace(/^\[\[|\]\]$/g, "").trim();
    // If there is a pipe alias [[Path|Alias]], take the path target before |
    if (s.includes("|")) {
      s = s.split("|")[0].trim();
    }
    // Strip leading hubsFolder/ or wiki/ or Fragmente/
    const prefixes = [this.settings.hubsFolder + "/", "wiki/", this.settings.fragmentsFolder + "/"];
    for (const p of prefixes) {
      if (s.toLowerCase().startsWith(p.toLowerCase())) {
        s = s.slice(p.length).trim();
      }
    }
    // Strip trailing .md
    s = s.replace(/\.md$/i, "").trim();
    return s;
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

  getCanvasFilePath(canvas: any): string {
    const canvasLeaves = this.app.workspace.getLeavesOfType("canvas");
    for (const leaf of canvasLeaves) {
      const view = leaf.view as any;
      if (view?.canvas === canvas && view?.file?.path) {
        return view.file.path;
      }
    }
    return "";
  }

  replaceCanvasNode(canvas: any, nodeId: string, newNodeData: any) {
    if (!canvas || !canvas.getData || !canvas.setData) return;
    const currentData = canvas.getData();
    const nextNodes = currentData.nodes.map((n: any) => (n.id === nodeId ? newNodeData : n));
    const withoutTarget = {
      ...currentData,
      nodes: currentData.nodes.filter((n: any) => n.id !== nodeId),
      edges: currentData.edges.filter((e: any) => e.fromNode !== nodeId && e.toNode !== nodeId)
    };
    const nextData = {
      ...currentData,
      nodes: nextNodes
    };
    canvas.setData(withoutTarget);
    canvas.setData(nextData);
    canvas.requestSave?.();
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

    const { kinds } = await this.loadKnowosConfig();
    const { rawKind, concept, body } = this.parseCardText(rawText);
    const { typeKey, displayName } = this.resolveKind(rawKind, kinds);
    const cleanConcept = this.cleanConceptName(concept);
    const fullTitle = `${cleanConcept} (${displayName})`;

    await this.ensureFolder(this.settings.fragmentsFolder);

    const canvasPath = this.getCanvasFilePath(canvas);
    const rememberedPath: string | undefined = node.unknownData?.canvasTutor?.fragment;

    let targetFile: TFile | null = null;
    if (rememberedPath) {
      const existing = this.app.vault.getAbstractFileByPath(rememberedPath);
      if (existing instanceof TFile) targetFile = existing;
    }

    const headingLine = `# ${fullTitle}`;
    const noteBody = body ? `${headingLine}\n\n${body}` : headingLine;

    if (targetFile) {
      // Update existing fragment file while preserving its existing frontmatter fields (like id, sources, etc.)
      const existingContent = await this.app.vault.read(targetFile);
      const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(existingContent);
      const existingIdMatch = fmMatch?.[1]?.match(/^id:\s*"?([^"\n]+)"?/m);
      const ulid = existingIdMatch ? existingIdMatch[1].trim() : generateUlid();

      const frontmatterLines = [
        "---",
        `id: "${ulid}"`,
        `title: "${fullTitle}"`,
        `tags: []`,
        `aliases: []`,
        `status: "draft"`,
        ...(canvasPath ? [`sources: ["[[${canvasPath}]]"]`] : []),
        `type: "${typeKey}"`,
        `concept: ["[[${cleanConcept}]]"]`,
        "---",
        noteBody,
        ""
      ];
      await this.app.vault.modify(targetFile, frontmatterLines.join("\n"));
    } else {
      const safeTitle = this.sanitizeFileName(fullTitle);
      let filePath = `${this.settings.fragmentsFolder}/${safeTitle}.md`;
      let counter = 1;
      while (await this.app.vault.adapter.exists(filePath)) {
        filePath = `${this.settings.fragmentsFolder}/${this.sanitizeFileName(`${cleanConcept} (${displayName} ${++counter})`)}.md`;
      }

      const ulid = generateUlid();
      const frontmatterLines = [
        "---",
        `id: "${ulid}"`,
        `title: "${fullTitle}"`,
        `tags: []`,
        `aliases: []`,
        `status: "draft"`,
        ...(canvasPath ? [`sources: ["[[${canvasPath}]]"]`] : []),
        `type: "${typeKey}"`,
        `concept: ["[[${cleanConcept}]]"]`,
        "---",
        noteBody,
        ""
      ];

      targetFile = await this.app.vault.create(filePath, frontmatterLines.join("\n"));
    }

    // Replace text node with file node on Canvas using clean two-step replacement
    if (canvas && canvas.getData) {
      const currentNode = canvas.getData().nodes.find((n: any) => n.id === node.id);
      if (currentNode) {
        const { text: _text, file: _oldFile, ...rest } = currentNode;
        const newNodeData: any = {
          ...rest,
          type: "file",
          file: targetFile.path
        };
        if (newNodeData.canvasTutor) {
          const { fragment: _f, ...restTutor } = newNodeData.canvasTutor;
          newNodeData.canvasTutor = restTutor;
        }
        this.replaceCanvasNode(canvas, node.id, newNodeData);
      }
    }

    new Notice(`Fragment abgelegt: ${targetFile.basename}`);

    if (this.settings.autoBuildHubs) {
      // Wait briefly for Obsidian's metadataCache to index the newly created/modified file
      window.setTimeout(() => {
        this.buildHubs(cleanConcept);
      }, 150);
    }
  }

  async unfileCardToText(canvas: any, node: any) {
    const filePath: string = node.unknownData?.file || "";
    if (!filePath) return;

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;

    const content = await this.app.vault.read(file);
    // Strip YAML frontmatter, keep `# Concept (Kind)` heading and body intact
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").replace(/^\s*\n/, "").trimEnd();

    if (canvas && canvas.getData) {
      const currentNode = canvas.getData().nodes.find((n: any) => n.id === node.id);
      if (currentNode) {
        const { file: _file, subpath: _subpath, ...rest } = currentNode;
        const newNodeData = {
          ...rest,
          type: "text",
          text: body,
          canvasTutor: {
            ...(rest.canvasTutor ?? {}),
            fragment: filePath
          }
        };
        this.replaceCanvasNode(canvas, node.id, newNodeData);
      }
    }

    new Notice(`Karte wieder als Text hergestellt.`);
  }

  parseCardText(rawText: string): { rawKind: string; concept: string; body: string } {
    const lines = rawText.split("\n");
    const firstLine = lines[0].trim();
    const bodyLines = lines.slice(1);

    // Check for '# Title (Kind)'
    const headingMatch = firstLine.match(/^#+\s*(.+?)\s*\(([^)]+)\)\s*$/);
    if (headingMatch) {
      return {
        concept: headingMatch[1].trim(),
        rawKind: headingMatch[2].trim(),
        body: bodyLines.join("\n").trim()
      };
    }

    // Check for 'Title (Kind)'
    const lineMatch = firstLine.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (lineMatch) {
      return {
        concept: lineMatch[1].trim(),
        rawKind: lineMatch[2].trim(),
        body: bodyLines.join("\n").trim()
      };
    }

    // Fallback: take first line as concept, default kind "Bemerkung"
    const concept = firstLine.replace(/^#+\s*/, "").trim() || "Gedanke";
    return {
      concept,
      rawKind: "Bemerkung",
      body: bodyLines.join("\n").trim()
    };
  }

  // --- Hub Synthesis (hub build) ---

  async buildHubs(targetConcept?: string) {
    const fragmentsFolder = this.settings.fragmentsFolder;
    const hubsFolder = this.settings.hubsFolder;

    await this.ensureFolder(hubsFolder);
    const { kinds, layout } = await this.loadKnowosConfig();

    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(fragmentsFolder + "/"));
    const conceptGroups: Record<
      string,
      { file: TFile; type: string; title: string; requires: string[] }[]
    > = {};

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      let fm = cache?.frontmatter;

      // Fallback: parse YAML directly if metadataCache hasn't updated yet
      if (!fm) {
        const raw = await this.app.vault.cachedRead(file);
        fm = this.parseSimpleFrontmatter(raw);
      }
      if (!fm) continue;

      const rawType = String(fm.type || "").trim();
      const type = rawType ? this.resolveKind(rawType, kinds).typeKey : "";
      const rawConcept = fm.concept;

      let concepts: string[] = [];
      if (Array.isArray(rawConcept)) {
        concepts = rawConcept.map((c) => this.cleanConceptName(String(c))).filter(Boolean);
      } else if (typeof rawConcept === "string") {
        const c = this.cleanConceptName(rawConcept);
        if (c) concepts = [c];
      }

      if (concepts.length === 0) {
        const match = file.basename.match(/^(.+?)\s*\(/);
        if (match) {
          const c = this.cleanConceptName(match[1]);
          if (c) concepts = [c];
        }
      }

      let requires: string[] = [];
      if (Array.isArray(fm.requires)) {
        requires = fm.requires.map((r: any) => String(r).trim()).filter(Boolean);
      } else if (typeof fm.requires === "string" && fm.requires.trim()) {
        requires = [fm.requires.trim()];
      }

      for (const c of concepts) {
        if (!c) continue;
        if (targetConcept && c.toLowerCase() !== this.cleanConceptName(targetConcept).toLowerCase()) continue;
        if (!conceptGroups[c]) conceptGroups[c] = [];
        conceptGroups[c].push({
          file,
          type,
          title: fm.title || file.basename,
          requires
        });
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

    let updatedCount = 0;
    for (const concept of conceptsToBuild) {
      const fragments = conceptGroups[concept];
      const hubBodyBlock = this.generateHubBlockMarkdown(concept, fragments, layout);
      const hubPath = `${hubsFolder}/${this.sanitizeFileName(concept)}.md`;

      const existingFile = this.app.vault.getAbstractFileByPath(hubPath);
      if (existingFile instanceof TFile) {
        const currentContent = await this.app.vault.read(existingFile);
        const startIdx = currentContent.indexOf("<!-- hub:start -->");
        const endIdx = currentContent.indexOf("<!-- hub:end -->");

        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          // Preserve everything outside <!-- hub:start --> ... <!-- hub:end --> (including frontmatter!)
          const before = currentContent.slice(0, startIdx);
          const after = currentContent.slice(endIdx + "<!-- hub:end -->".length);
          const updatedContent = `${before}${hubBodyBlock}${after}`;
          if (updatedContent !== currentContent) {
            await this.app.vault.modify(existingFile, updatedContent);
          }
          updatedCount++;
        } else {
          // If the file has frontmatter, preserve it; otherwise add default hub frontmatter
          const fmMatch = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(currentContent);
          const fmBlock = fmMatch
            ? fmMatch[0].trimEnd()
            : [
                "---",
                `id: "${generateUlid()}"`,
                `title: "${concept}"`,
                `type: "hub"`,
                `status: "draft"`,
                "---"
              ].join("\n");
          const newContent = `${fmBlock}\n# ${concept}\n\n${hubBodyBlock}\n`;
          await this.app.vault.modify(existingFile, newContent);
          updatedCount++;
        }
      } else {
        const fmBlock = [
          "---",
          `id: "${generateUlid()}"`,
          `title: "${concept}"`,
          `type: "hub"`,
          `status: "draft"`,
          "---"
        ].join("\n");
        const newContent = `${fmBlock}\n# ${concept}\n\n${hubBodyBlock}\n`;
        await this.app.vault.create(hubPath, newContent);
        updatedCount++;
      }
    }

    new Notice(
      targetConcept
        ? `Hub Note '${targetConcept}' aktualisiert.`
        : `Hub Notes aktualisiert: ${updatedCount} Konzepte verarbeitet.`
    );
  }

  generateHubBlockMarkdown(
    concept: string,
    fragments: { file: TFile; type: string; title: string; requires: string[] }[],
    layout: HubLayoutSection[]
  ): string {
    // Sort fragments deterministically by basename
    const sortedFragments = [...fragments].sort((a, b) =>
      a.file.basename < b.file.basename ? -1 : a.file.basename > b.file.basename ? 1 : 0
    );
    const usedFiles = new Set<string>();

    // Collect prerequisites (from `requires` in fragments, excluding self-references to fragments of the same concept)
    const selfNames = new Set(sortedFragments.map((f) => f.file.basename.toLowerCase()));
    selfNames.add(concept.toLowerCase());
    const prerequisites: string[] = [];
    for (const frag of sortedFragments) {
      for (const req of frag.requires) {
        const reqTarget = this.cleanConceptName(req);
        if (reqTarget && !selfNames.has(reqTarget.toLowerCase())) {
          const formatted = req.startsWith("[[") ? req : `[[${reqTarget}]]`;
          if (!prerequisites.includes(formatted)) {
            prerequisites.push(formatted);
          }
        }
      }
    }

    // Group sections by heading
    const headingOrder: string[] = [];
    const groupedByHeading: Record<string, { subheading?: string; items: string[] }[]> = {};

    for (const sec of layout) {
      let items: string[] = [];
      if (sec.prerequisites) {
        items = prerequisites;
      } else if (Array.isArray(sec.types) && sec.types.length > 0) {
        const matching = sortedFragments.filter((f) => sec.types!.includes(f.type));
        for (const m of matching) {
          usedFiles.add(m.file.path);
          items.push(`![[${m.file.basename}]]`);
        }
      }

      if (items.length > 0) {
        if (!groupedByHeading[sec.heading]) {
          headingOrder.push(sec.heading);
          groupedByHeading[sec.heading] = [];
        }
        groupedByHeading[sec.heading].push({
          subheading: sec.subheading,
          items
        });
      }
    }

    // Remaining fragments go into "## Weitere"
    const remaining = sortedFragments.filter((f) => !usedFiles.has(f.file.path));
    if (remaining.length > 0) {
      const weitereHeading = "Weitere";
      headingOrder.push(weitereHeading);
      groupedByHeading[weitereHeading] = [
        {
          items: remaining.map((f) => `![[${f.file.basename}]]`)
        }
      ];
    }

    const lines: string[] = ["<!-- hub:start -->", ""];

    for (const heading of headingOrder) {
      lines.push(`## ${heading}`);
      const subBlocks = groupedByHeading[heading];
      for (const sub of subBlocks) {
        if (sub.subheading) {
          lines.push("");
          lines.push(`### ${sub.subheading}`);
        }
        for (const item of sub.items) {
          lines.push(item);
        }
      }
      lines.push("");
    }

    lines.push("<!-- hub:end -->");
    return lines.join("\n");
  }

  parseSimpleFrontmatter(raw: string): Record<string, any> | null {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    if (!match) return null;
    const yaml = match[1];
    const result: Record<string, any> = {};
    let currentKey: string | null = null;

    for (const line of yaml.split(/\r?\n/)) {
      const listMatch = line.match(/^\s*-\s*(.+)$/);
      if (listMatch && currentKey) {
        if (!Array.isArray(result[currentKey])) result[currentKey] = [];
        result[currentKey].push(listMatch[1].replace(/^["']|["']$/g, "").trim());
        continue;
      }
      const kvMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (kvMatch) {
        currentKey = kvMatch[1];
        const val = kvMatch[2].trim();
        if (!val) {
          result[currentKey] = [];
        } else if (val.startsWith("[") && val.endsWith("]")) {
          const inner = val.slice(1, -1).trim();
          result[currentKey] = inner
            ? inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""))
            : [];
        } else {
          result[currentKey] = val.replace(/^["']|["']$/g, "");
        }
      }
    }
    return result;
  }

  // --- Status Badges (Draft Kringel & Fragment Dots) ---

  updateCanvasBadges() {
    const canvasLeaves = this.app.workspace.getLeavesOfType("canvas");
    for (const leaf of canvasLeaves) {
      const canvas = (leaf.view as any)?.canvas;
      if (!canvas || !canvas.nodes) continue;

      for (const [, node] of canvas.nodes) {
        const el = node.nodeEl as HTMLElement;
        if (!el) continue;

        const data = node.unknownData;
        const isFragmentFile =
          data?.type === "file" &&
          typeof data?.file === "string" &&
          data.file.startsWith(this.settings.fragmentsFolder + "/");
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

  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line);
    const sub = line.slice(0, cursor.ch);

    const match = sub.match(/#\s*([a-zA-Z0-9äöüÄÖÜß\-_ ()]*)$/);
    if (!match) return null;

    return {
      start: { line: cursor.line, ch: sub.length - match[0].length },
      end: cursor,
      query: match[1]
    };
  }

  getSuggestions(context: EditorSuggestContext): SuggestionItem[] {
    const rawQuery = context.query.trim();
    const query = rawQuery.toLowerCase();
    const kinds = this.plugin.settings.noteKinds;

    // Collect known concepts from wiki/ hubs and Fragmente/
    const concepts = new Set<string>();
    const hubFiles = this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(this.plugin.settings.hubsFolder + "/"));
    for (const h of hubFiles) {
      concepts.add(h.basename);
    }

    const fragmentFiles = this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(this.plugin.settings.fragmentsFolder + "/"));
    for (const f of fragmentFiles) {
      const match = f.basename.match(/^(.+?)\s*\(/);
      if (match) concepts.add(match[1].trim());
    }

    const suggestions: SuggestionItem[] = [];

    for (const concept of concepts) {
      for (const kind of kinds) {
        const display = `# ${concept} (${this.plugin.capitalize(kind)})`;
        if (
          !query ||
          concept.toLowerCase().includes(query) ||
          kind.toLowerCase().includes(query) ||
          display.toLowerCase().includes(query)
        ) {
          suggestions.push({
            concept,
            kind: this.plugin.capitalize(kind),
            display
          });
        }
      }
    }

    const cleanConceptQuery = rawQuery.replace(/\([^)]*$/, "").trim();
    if (cleanConceptQuery && !Array.from(concepts).some((c) => c.toLowerCase() === cleanConceptQuery.toLowerCase())) {
      for (const kind of kinds) {
        suggestions.push({
          concept: cleanConceptQuery,
          kind: this.plugin.capitalize(kind),
          display: `# ${cleanConceptQuery} (${this.plugin.capitalize(kind)})`
        });
      }
    }

    return suggestions.slice(0, 15);
  }

  renderSuggestion(value: SuggestionItem, el: HTMLElement): void {
    const row = el.createDiv({ cls: "fragment-suggest-row" });
    row.createSpan({ text: `# ${value.concept} `, cls: "fragment-suggest-concept" });
    row.createSpan({ text: `(${value.kind})`, cls: "fragment-suggest-kind" });
  }

  selectSuggestion(value: SuggestionItem, _evt: MouseEvent | KeyboardEvent): void {
    if (!this.context) return;
    const replacement = `# ${value.concept} (${value.kind})\n`;
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
