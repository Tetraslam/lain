<div align="center">

# lain

**a graph-based ideation engine**

plant a seed. a graph of tool-using agents branches, researches, and builds on
itself — until something extraordinary emerges.

[![CI](https://github.com/Tetraslam/lain/actions/workflows/ci.yml/badge.svg)](https://github.com/Tetraslam/lain/actions/workflows/ci.yml)

</div>

---

```bash
curl -fsSL https://raw.githubusercontent.com/Tetraslam/lain/main/bootstrap.sh | bash
```

```bash
lain init                                   # pick a provider, paste a key
lain "a religion that worships entropy" --mission
```

Every exploration is one portable `.db` file.

## What it does

A seed branches into `n` directions, recurses to depth `m`, and every node is
expanded by a tool-using **agent** — never a one-shot completion. Each one can:

- **read the whole graph** — diverge from and build on other branches
- **ground in your corpus** — drop in PDFs, notes, CSVs, images
- **search & cite the web** — the `research` lens footnotes real sources `[1]`
- **share findings** — a discovery in one branch reaches all the others
- **call MCP tools & link branches** — the graph wires itself together

A **mission** gives the run a goal and a success checklist, then validates the
finished graph against it. A **synthesis** pass surfaces the connections,
contradictions, and emergent patterns. Explore in the **CLI**, a keyboard
**TUI**, or a **web** UI — and sync it all to Obsidian.

## A taste

```bash
lain "what if cities were grown" -n 3 -m 2          # branch an idea
lain "the myth of my setting" --corpus ./lore/      # ground it in your files
lain "the frontier LLM training recipe" --ext research   # cited web sources
lain tui                                            # watch the agents think
lain serve                                          # web UI at :3001
```

```bash
lain tree            lain show root-1            lain mission
lain synthesize      lain export idea.db         lain sync idea.db
```

## MCP tools

Add any remote [MCP](https://modelcontextprotocol.io) server and its tools join
the agents' toolbelt — a web-search server like Firecrawl is what powers the
`research` lens' citations.

```bash
lain mcp add firecrawl https://mcp.firecrawl.dev/<key>/v2/mcp        # key in URL
lain mcp add ctx https://mcp.example.com/v1 --bearer "$TOKEN"        # bearer token
lain mcp add db  https://mcp.example.com/v1 --api-key "$KEY"         # API-key header
lain mcp add svc https://mcp.example.com/v1 --header "X-Org: acme"   # arbitrary headers

lain mcp test svc     # connect + list its tools     lain mcp list     # secrets redacted
```

## Providers

Bedrock · Anthropic · OpenAI · OpenRouter · any OpenAI-compatible endpoint
(ollama, together, groq, vLLM) via `--base-url`. Set with `lain init`.

## Lifecycle

```bash
lain doctor          # check install, config, credentials
lain update          # pull + rebuild — your .db files and config stay untouched
lain uninstall
```

## From source

Requires [bun](https://bun.sh). `bash install.sh` builds and puts `lain` on your
PATH; `pnpm test` runs the suite. Internals live in [`AGENTS.md`](./AGENTS.md).

<div align="center">
<sub>named after lain iwakura. everything is connected.</sub>
</div>
