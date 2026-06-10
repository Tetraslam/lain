<div align="center">

# lain

**a graph-based ideation engine**

plant a seed. watch a graph of tool-using agents branch, research, and build on
one another — until something extraordinary emerges.

[![CI](https://github.com/Tetraslam/lain/actions/workflows/ci.yml/badge.svg)](https://github.com/Tetraslam/lain/actions/workflows/ci.yml)

</div>

---

```bash
curl -fsSL https://raw.githubusercontent.com/Tetraslam/lain/main/bootstrap.sh | bash

lain init                                   # pick a provider, paste a key
lain "a religion that worships entropy" --mission
```

The installer brings its own prerequisites, `lain init` takes a minute, and the
last line hands you a graph of developed ideas. Every exploration is one
portable `.db` file.

## What it does

You give lain a seed. It branches into `n` directions, recurses to depth `m`,
and expands every node with a tool-using **agent** — never a one-shot
completion. Each node-agent can:

- **read the whole graph** — study, diverge from, and build on other branches
- **retrieve from your corpus** — drop in PDFs, notes, CSVs, images and it
  grounds ideas in *your* material, not generic ones
- **search & cite the web** — with the `research` lens it grounds claims in real
  sources and footnotes them `[1]`
- **share findings** — a discovery in one branch reaches all the others, so they
  genuinely collaborate
- **call tools & link branches** — extension tools, any remote **MCP** server,
  and cross-links that wire the graph together

A **mission** gives the run a goal and a checklist of success criteria, then
validates the finished graph against it. A **synthesis** pass surfaces the
connections, contradictions, and emergent patterns across the whole thing.

Explore it in the **CLI**, a keyboard-driven **TUI**, or a **web** UI — and sync
it all to Obsidian.

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

## Tools beyond the graph

Add any remote [MCP](https://modelcontextprotocol.io) server and its tools join
the agents' toolbelt automatically — authenticate however the server expects:

```bash
lain mcp add firecrawl https://mcp.firecrawl.dev/<key>/v2/mcp        # key in URL
lain mcp add ctx https://mcp.example.com/v1 --bearer "$TOKEN"        # bearer token
lain mcp add db  https://mcp.example.com/v1 --api-key "$KEY"         # API-key header
lain mcp add svc https://mcp.example.com/v1 --header "X-Org: acme"   # arbitrary headers

lain mcp test svc     # connect + list its tools     lain mcp list     # secrets redacted
```

A web-search server (e.g. Firecrawl) is what powers the `research` lens'
citations.

## Providers

Bedrock · Anthropic · OpenAI · OpenRouter · any OpenAI-compatible endpoint
(ollama, together, groq, vLLM) via `--base-url`. Set with `lain init`.

## Lifecycle

```bash
lain doctor          # check install, config, credentials
lain update          # pull + rebuild — your .db files and config stay untouched
lain uninstall
```

## Build from source

Requires [bun](https://bun.sh):

```bash
bash install.sh      # build + put `lain` on your PATH
pnpm test            # the full test suite
```

Architecture and internals live in [`AGENTS.md`](./AGENTS.md).

<div align="center">
<sub>named after lain iwakura. everything is connected.</sub>
</div>
