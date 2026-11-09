# Canvas Fragments (`obsidian-canvas-fragments`)

A minimalist, high-speed Obsidian plugin that turns your Obsidian Canvas into a frictionless atomic slip-box (Zettelkasten) with automated Hub Note synthesis.

## Features

1. **Clean Canvas Rendering:** Hides ugly YAML frontmatter containers, inline titles, and embed headers inside Canvas cards. Embeds look like clean index cards.
2. **Visual Status Indicators:**
   - **Hollow Circle:** Transient text draft on Canvas.
   - **Solid Accent Dot:** Filed atomic fragment in `Fragmente/` (Click opens note in new tab).
3. **Canvas Autocomplete:** Typing `# ` in a Canvas card suggests `# Concept (Kind)` (e.g. `# Vektorraum (Definition)`).
4. **Filing Fragments:** Right-click a card $\to$ **"Als Fragment ablegen"** creates `Fragmente/Concept (Kind).md` with clean frontmatter and links it to the concept.
5. **Automated Hub Builder:** Groups all fragments by concept and compiles clean Hub Notes in `wiki/<Concept>.md` with structured transclusions (`## Definition`, `## Sätze`, `## Beispiele`...).
6. **100% Native & Mobile-Friendly:** Written in pure TypeScript with zero external dependencies, no Python, no CLI daemons, and zero background network calls. Runs seamlessly on iOS, iPadOS, macOS, Linux, and Windows.
