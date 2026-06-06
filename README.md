# lain

> a graph-based ideation engine. plant a seed idea, and watch a graph of
> tool-using agents branch, research, and build on each other until something
> extraordinary emerges.

Named after Lain Iwakura. Everything is connected.

lain takes a seed, branches it into `n` directions, recurses to depth `m`, and
expands each node with an **agent** — not a one-shot completion. Each node-agent
can read any other node in the graph, retrieve from a corpus of *your* source
material (PDFs, notes, CSVs, images), call remote tools over MCP (web search,
scraping, …), record findings other branches build on, and link across the
graph. A **mission** gives the whole thing a goal and a success rubric. The
result is a DAG of developed ideas you can explore in the CLI, a TUI, or a web
UI, and sync to Obsidian.

---

## Install

Requires [Bun](https://bun.sh) and [pnpm](https://pnpm.io).

```bash
git clone https://github.com/Tetraslam/lain
cd lain
bash install.sh          # builds everything + puts `lain` on your PATH (~/.local/bin)
```

Then configure a provider:

```bash
lain init                # interactive: pick provider (bedrock / anthropic / openai / openrouter) + key
lain doctor              # verify install, config, credentials
```

Non-interactive setup (for scripts/agents):

```bash
lain init --non-interactive --provider bedrock   --api-key ABSK... --region us-west-2
lain init --non-interactive --provider anthropic --api-key sk-ant-...
lain init --non-interactive --provider openrouter --api-key sk-or-...
lain init --non-interactive --provider openai    --api-key sk-... --base-url http://localhost:11434/v1
```

Update or remove later:

```bash
lain update              # git pull + rebuild — your explorations (.db) and config are never touched
lain uninstall           # how to remove (or: bash uninstall.sh)
```

---

## Quickstart

```bash
# the simplest thing: branch an idea (fast, one-shot per node)
lain "what if cities were grown instead of built" -n 3 -m 2

# go agentic: nodes become tool-using agents that read the graph + collaborate
lain "a religion that worships entropy" --mission

# ground it in YOUR world: drop in files; agents retrieve from them
lain "the politics of my setting" --corpus ./worldbuilding/

# give agents the web (via a remote MCP server)
lain mcp add firecrawl https://mcp.firecrawl.dev/<your-key>/v2/mcp
lain "the state of AI agent frameworks in 2026" --agentic

# look at what you made
lain tree                          # tree of the most recent exploration
lain show root-1                   # read a node
lain mission                       # the intent contract + shared findings
lain tui                           # interactive terminal UI
lain serve                         # web UI at http://localhost:3001
```

Every exploration is a single portable `.db` file in your current directory.

---

## The ideas that make lain different

### Nodes are agents (the substrate)
Each node is expanded by an agent with a toolbelt, not a single prompt. By
default (in `--agentic` mode) every node-agent can:

- `outline` / `read_node` / `search_nodes` — see and study the whole graph
- `search_corpus` — retrieve from your ingested source material
- `read_findings` / `note_finding` — the **shared knowledge library**: a
  discovery in one branch becomes available to all others
- `link_to_node` — wire a cross-link to a related branch
- plus any tools from **extensions** and **MCP servers**

This is why branches *collaborate* instead of merely coexisting.

### Corpus — ground agents in your world
`--corpus <file|dir>` (or `lain corpus add ...`) ingests text, markdown, CSV,
JSON, **PDF** (real text extraction), and **images** (kept for multimodal use).
Retrieval is BM25 over chunked text. Agents consult it before writing, so output
is grounded in *your* material, not generic.

```bash
lain corpus add ./notes ./data.csv ./map.png --db myidea.db
lain corpus list
lain corpus search "trade routes"
```

### Missions — a goal, not just a topic
`--mission` derives an explicit **intent** and a finite checklist of **success
criteria** from your seed, injects them into every node-agent, and records a
shared findings library as the graph grows.

```bash
lain "a heist in zero gravity" --mission
lain "a heist in zero gravity" --mission "focus on the crew's interpersonal fractures"
lain mission                      # view the contract + findings
```

### Remote MCP — borrow the whole tool ecosystem
Add any remote [MCP](https://modelcontextprotocol.io) server; its tools join the
agentic toolbelt automatically.

```bash
lain mcp add <name> <url> --bearer <token>        # or --api-key, or --header 'K: V'
lain mcp test <name>                              # connect + list its tools
lain mcp list                                     # secrets redacted
```

### Synthesis — find the connections
After generating, `lain synthesize` traverses the whole graph for cross-links,
contradictions, and emergent patterns, producing **staged** annotations you
review and merge.

```bash
lain synthesize                   # stage annotations
lain merge-synthesis <id>         # apply (or --auto-merge when synthesizing)
```

### Obsidian sync
Explorations round-trip to a folder of markdown with frontmatter + wikilinks.

```bash
lain export myidea.db --out ~/vault/lain/    # one-shot
lain sync myidea.db                          # bidirectional (edit in Obsidian, sync back)
lain export myidea.db --canvas               # Obsidian .canvas (radial layout)
```

---

## Surfaces

All three speak the same engine and support agentic generation + corpus:

- **CLI** — `lain ...` (fully scriptable; every interactive command has flags)
- **TUI** — `lain tui` (keyboard-driven graph explorer; `?` for shortcuts)
- **Web** — `lain serve` then open `http://localhost:3001` (editorial layout,
  graph overlay, corpus drag-drop, a live "thinking" feed while agents work)

## Providers

First-class: **Amazon Bedrock** (bearer-token), **Anthropic**, **OpenAI**,
**OpenRouter**, and any **OpenAI-compatible** endpoint (ollama, together, groq,
vLLM) via `--base-url`. Configure with `lain init` or `lain config set`.

## Extensions

Lenses that shape generation and add domain tools: `freeform` (default),
`worldbuilding` (coins in-world names via a corpus-grounded sub-agent),
`debate`, `research`. Select with `--ext <name>`; list with `lain extensions`.

---

## How it's built

A Bun + pnpm + turborepo monorepo:

| package | role |
|---------|------|
| `shared` | types, config, agent wire-protocol |
| `core` | graph + SQLite storage, orchestrator, **corpus**, **mcp**, **mission**, agentic loop, tools, synthesis, sync, export |
| `agents` | provider abstraction (Bedrock/Anthropic/OpenAI/OpenRouter) + the `AgentRunner` tool loop |
| `extensions` | plugin system + built-in lenses |
| `cli` / `tui` / `web` | the three surfaces |

```bash
pnpm build      # build all packages
pnpm test       # run the test suite
```

See [`AGENTS.md`](./AGENTS.md) for the contributor/architecture deep-dive.
