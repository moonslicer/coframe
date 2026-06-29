# Agentic Design Canvas

An AI design agent that **perceives and edits a Figma-like vector document**, co-editing
alongside a human on a shared canvas. Describe a screen in plain English and the agent
plans, builds, and refines it; then keep editing by hand or by asking for changes.

The agent runs a **perceive → plan → act → verify** loop: it reads the scene graph (plus
a rendered thumbnail for spatial context), mutates the document through high-level semantic
tools, and verifies the result structurally before handing control back.

> **Status:** working personal project / demo. Not a production tool — expect rough edges.

## Quickstart

Requires Node.js 18+ and an LLM API key (OpenAI or Anthropic).

```bash
cd app
npm install
cp .env.example .env      # then edit .env and add your API key
npm run dev
```

`npm run dev` starts two processes:

- **client** — Vite dev server at http://localhost:5173 (the canvas UI)
- **server** — agent + document server at http://localhost:8787

Open the client URL, type a prompt (e.g. *"Design a polished mobile login screen"*), and
watch the agent build it. You can also restart both cleanly with `./restart-dev.sh`.

### Configuration

Set your provider in `app/.env` (see `app/.env.example`):

```
LLM_PROVIDER=openai          # or: anthropic
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.5
```

Your `.env` is gitignored — only the `.env.example` template is committed.

## Repo layout

```
app/                 The application (client + server + agent)
  src/client/        React canvas UI (Canvas, Inspector, TreeView, PlayMode)
  src/server/        Hono + WebSocket document/agent server
  src/agent/         The perceive → plan → act → verify loop and LLM adapter
  src/render/        SVG build + resvg rasterization (perception thumbnails)
  src/shared/        Scene-graph types, primitives, tools, design system
docs/                Design docs and specs (architecture, perception, tools, concurrency)
docs/archive/        Earlier standalone prototype (headless-loop)
```

## Useful scripts (run inside `app/`)

| Command | What it does |
|---|---|
| `npm run dev` | Run client + server for local development |
| `npm run build` | Type-check and build the client |
| `npm run typecheck` | Type-check only |
| `npm run smoke` | Render smoke test; other `smoke:*` scripts cover render/agent/tools |

## Design docs

The thinking behind the architecture lives in [`docs/`](docs/):

- [`agentic-canvas-design.md`](docs/agentic-canvas-design.md) — the design doc / overview
- [`perception-spec.md`](docs/perception-spec.md) — how the agent sees the canvas
- [`tool-vocabulary-spec.md`](docs/tool-vocabulary-spec.md) — the edit tools
- [`concurrency-spec.md`](docs/concurrency-spec.md) — human/agent co-editing & merge model
- [`agent-loop-spec.md`](docs/agent-loop-spec.md) — the runtime loop

## License

[MIT](LICENSE)
