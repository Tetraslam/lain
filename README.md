<div align="center">

# lain

**a graph-based ideation engine**

plant a seed. watch a graph of tool-using agents branch, research,
and build on one another — until something extraordinary emerges.

[![CI](https://github.com/Tetraslam/lain/actions/workflows/ci.yml/badge.svg)](https://github.com/Tetraslam/lain/actions/workflows/ci.yml)

</div>

---

```bash
curl -fsSL https://raw.githubusercontent.com/Tetraslam/lain/main/bootstrap.sh | bash
```

```bash
lain init                              # pick a provider, paste a key
lain "a religion that worships entropy" --mission
```

That's it. The installer brings its own prerequisites; `lain init` takes a
minute; the second line gives you a graph of developed ideas.

---

## What it does

You give lain a seed. It branches into `n` directions, recurses to depth `m`,
and expands every node with an **agent** — not a one-shot completion. Each
node-agent can:

- **read the whole graph** — study, diverge from, and build on other branches
- **retrieve from your corpus** — drop in PDFs, notes, CSVs, images; it grounds
  ideas in *your* material instead of generic ones
- **share findings** — a discovery in one branch becomes available to all the
  others, so branches genuinely collaborate
- **call tools** — extension tools and any remote **MCP** server (web search,
  scraping, databases, …)
- **link across branches** — the graph wires itself together

A **mission** gives the whole run a goal and a checklist of success criteria. A
**synthesis** pass then surfaces the connections, contradictions, and emergent
patterns across the finished graph.

Explore it in the **CLI**, a keyboard-driven **TUI**, or a **web** UI — and sync
the whole thing to Obsidian. Every exploration is one portable `.db` file.

## A taste

```bash
lain "what if cities were grown" -n 3 -m 2        # branch an idea
lain "the myth of my setting" --corpus ./lore/    # ground it in your files
lain "the state of AI agents in 2026" --agentic   # + web tools via MCP
lain tui                                          # watch the agents think
lain serve                                        # web UI at :3001
```

```bash
lain tree            lain show root-1            lain mission
lain synthesize      lain export idea.db         lain sync idea.db
```

## Tools beyond the graph

```bash
# add any remote MCP server — its tools join the agents' toolbelt
lain mcp add firecrawl https://mcp.firecrawl.dev/<key>/v2/mcp
lain mcp test firecrawl
```

## Providers

Bedrock · Anthropic · OpenAI · OpenRouter · any OpenAI-compatible endpoint
(ollama, together, groq, vLLM) via `--base-url`. Set with `lain init`.

## Lifecycle

```bash
lain doctor          # check install, config, credentials
lain update          # pull + rebuild — your .db files and config are untouched
lain uninstall
```

## Build from source

Requires [bun](https://bun.sh). Clone, then:

```bash
bash install.sh      # build + put `lain` on your PATH
pnpm test            # 160+ tests
```

Architecture and internals live in [`AGENTS.md`](./AGENTS.md).

<div align="center">
<sub>named after lain iwakura. everything is connected.</sub>
</div>
