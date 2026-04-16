# TUI Design Document

## User Journey — First Principles

### Who is the user?
Someone who just ran `lain "idea" -n 3 -m 2` and now has a .db file with 12 nodes of rich content. They want to:
1. **Explore** — navigate the tree, read nodes, understand the graph structure
2. **Evaluate** — compare sibling nodes, identify the most interesting branches
3. **Act** — extend promising branches, prune dead ends, redirect weak nodes
4. **Orient** — always know where they are in the graph, how deep, what branch

### How do they launch?
- `bun lain-tui` — no argument. If there's one .db file, open it. If multiple, show a picker.
- `bun lain-tui exploration.db` — direct open.

### What's the first thing they see?

If multiple DBs or multiple explorations: a **selection screen** (SelectRenderable).
Otherwise: the **exploration view** — the main interface.

---

## The Exploration View — Layout

The core insight from the screenshots: **the tree panel was too narrow and the content panel was too cramped on normal terminals, and too wasteful on ultrawides.** The tree isn't a sidebar — it's the primary navigation. The content is the primary reading surface. Neither should feel cramped.

### Adaptive Layout

The layout adapts to terminal width:

**Narrow (<100 cols)**: Single panel mode. Tree view is full-width. Press Enter to see content full-width. Esc goes back.

**Normal (100-160 cols)**: Split view. Tree panel is **fixed 40 cols** (enough for tree connectors + titles). Content panel fills the rest.

**Wide (>160 cols)**: Split view with **generous tree panel** (fixed 50 cols) and content has plenty of room.

The tree panel should be fixed-width, not percentage-based. The tree's content (connectors + titles) has a natural width. Percentage-based sizing makes it too narrow on small terminals and wastes space on wide ones.

---

## Tree Panel — Rethought

### Problem with current approach
Using a single TextRenderable for the entire tree means:
- No per-line click handling
- No per-line hover states
- Text wraps within the panel when it shouldn't
- Can't color different parts of a line (connectors vs title vs status)

### New approach: Use SelectRenderable

SelectRenderable gives us:
- Built-in j/k navigation with scroll
- Per-item rendering
- Selection state management
- Scroll indicators
- Keyboard handling out of the box

But SelectRenderable might be too opinionated for a tree. Alternative: build each tree line as a **separate TextRenderable with styled chunks** inside a ScrollBox. Each line gets:
- Dim connector characters (`├─`, `└─`, `│`) in muted color
- Title in normal color (bright when selected)
- Status badge in accent color
- **No wrapping** — lines are truncated with ellipsis **at the panel boundary**, not at some arbitrary character count

The key fix for truncation: set the tree line TextRenderable's **width to "100%"** of the tree panel, and let OpenTUI handle overflow. Or manually truncate based on actual panel width (which we can get from the renderer's resize event or the computed layout).

### Tree line format

```
  ├─ The Debt of the Sky: A World Whe…
  │  ├─ The Towers of Receipt: Engine…
  │  ├─ The Storm Brokers: Political …
  │  └─ The Silence That Follows: On …
  ├─ The Readers of Coming Thunder
  │  ├─ The Thunder Tongue: Prophecy,…
  │  ├─ The War of Precedence: Who Ow…
  │  └─ The Hollow Beneath the Spires
  └─ City of a Thousand Spires: The …
     ├─ The Capacitor Crypts: What Ve…
     ├─ The Tethered: Brotherhood of …
     └─ The Blessed Dead: Saints, Sca…
```

Selected node gets: `▸` prefix, bright title color, subtle bg highlight.
Connectors always in muted/dim color.
Pruned nodes in red-dim with strikethrough if possible.

---

## Content Panel — Rethought

### Use MarkdownRenderable

The node content is already markdown. Using MarkdownRenderable means:
- **Bold** text renders as bold
- `*italic*` renders as italic
- `**terms**` render with visual weight
- Headers get proper treatment
- Lists get proper indentation

Above the markdown content, a **metadata header** built with styled Text:
```
root > The Debt of the Sky… > The Silence That Fo…

The Silence That Follows: On Unauthorized Discharge
────────────────────────────────────────────────────
depth 2  ·  branch 3  ·  complete
us.anthropic.claude-sonnet-4-6 (bedrock)
direction: Veth's forbidden discharge consequences

[markdown-rendered content here]

── cross-links ──
→ root-2-1  The Verification Problem
  shared dependency on pressure infrastructure

── children (3) ──
1. Symbiotic Wayfinding Cultures
2. Bioluminescent Communication Protocols
3. Deep-Light Farming Economies
```

---

## States & Transitions

### States
1. **Picker** — shown when multiple DBs/explorations. SelectRenderable list.
2. **Exploring** — main split view (tree + content). Default state.
3. **Reading** — content panel focused. j/k scrolls content. (On narrow terminals: content is full-screen.)
4. **Help** — overlay showing keybinds. Any key dismisses.

### Transitions
- Picker → Exploring (select an exploration)
- Exploring → Reading (Enter, →, or Tab)
- Reading → Exploring (Esc, ←, or Tab)
- Any → Help (?)
- Help → Previous state (any key)
- Any → Quit (q from Exploring, or Ctrl+C)

---

## Keybindings

### Global
- `q` — quit (from tree panel only, so you don't accidentally quit while reading)
- `?` — help overlay
- `Ctrl+C` — force quit from anywhere

### Tree Panel (Exploring)
- `j` / `↓` — next node
- `k` / `↑` — previous node
- `Enter` / `→` / `l` — open selected node in content panel
- `Tab` — switch to content panel
- `g` — jump to root
- `G` — jump to last node

### Content Panel (Reading)
- `j` / `↓` — scroll down
- `k` / `↑` — scroll up
- `Esc` / `←` / `h` — back to tree panel
- `Tab` — switch to tree panel
- `g` — scroll to top
- `G` — scroll to bottom
- `d` — scroll half page down
- `u` — scroll half page up

### Mouse
- Click tree node → select it + show content
- Scroll wheel in tree → scroll tree
- Scroll wheel in content → scroll content
- Click content panel → focus it

---

## Visual Design

### Color usage (Tokyo Night palette, no forced backgrounds)
- **Accent**: `#bb9af7` (purple) — active panel border, selected node marker
- **Secondary**: `#7aa2f7` (blue) — metadata keys, cross-link arrows
- **Tertiary**: `#0db9d7` (cyan) — node IDs, breadcrumb separators
- **Title**: `#c0caf5` (bright fg) — node titles, headers
- **Body**: `#a9b1d6` (normal fg) — content text
- **Dim**: `#565f89` — tree connectors, metadata values, footer
- **Muted**: `#3b3f5c` — inactive borders, separators
- **Status colors**: red `#f7768e` for pruned, yellow `#e0af68` for pending, green `#9ece6a` for complete

### Typography
- Section headers in content: bright fg + underline
- Metadata keys: blue, values: dim
- Breadcrumb: dim text with cyan `>` separators
- Footer: very dim, only shows context-relevant keys
- Tree connectors: muted color (almost invisible — structural, not attention-grabbing)
- Selected tree node: bright title + purple `▸` marker

### Borders
- Active panel: accent purple `#bb9af7`, round style
- Inactive panel: muted `#3b3f5c`, round style
- No panel titles in the border (clean, minimal)

### Header
- Minimal: single line, dim, right-aligned or centered
- Shows: exploration name · node count · extension
- No box around it

### Footer
- Single line, dim
- Context-sensitive: different keys shown for tree vs content mode
- Format: `j/k navigate · enter open · ? help · q quit`

---

## Components Used

| Component | Purpose |
|---|---|
| `BoxRenderable` | Layout containers, panels |
| `TextRenderable` with `t` template | Styled tree lines, metadata, headers, footer |
| `ScrollBoxRenderable` | Scrollable tree + content panels |
| `MarkdownRenderable` | Node content rendering |
| `SelectRenderable` | DB/exploration picker |
| `@opentui-ui/dialog` | Confirmation dialogs (prune, etc.) |
| `@opentui-ui/toast` | Action feedback (pruned, extended, etc.) |
