# deizmem

A personal external memory, as a service. You send it a file or a note (an insurance policy,
a prescription, a receipt, a voice note), and later an agent gives it back to you with a
citation of where it came from.

deizmem **does not chat, classify or write prose**, and it runs no LLM. That is the job of the
agent using it (Hermes Agent, OpenClaw, or anything that speaks MCP). The memory keeps the
original, extracts its text, indexes it, and **checks against the document** whatever the
agent decides to store.

> The agent thinks; the memory remembers and verifies.

The design and its rationale live in [CLAUDE.md](CLAUDE.md), in Spanish. This file covers
how to run it.

## What it does

- **Captures anything, no questions asked.** It acknowledges at once and reads the file in
  the background.
- **Extracts text through pluggable lanes:** markitdown (PDF, docx, xlsx…), OCR (photos and
  scanned PDFs, HEIC included) and Whisper (voice notes). Every lane is optional. If no lane
  can read something, it goes to the `needs_text` queue for the agent to supply the text.
- **Searches hybrid and language-free:** full-text without stemming, plus vectors from a
  multilingual model. A question in English finds a document in Spanish.
- **Stores hard facts with evidence.** Every field the agent extracts (a deductible, an expiry
  date) must come with a literal excerpt from the document, and that is checked in code.
  Validity is computed: `current`, `expired`, `superseded` or `conflict`.
- **Verifies the agent's prose.** `verify` returns the figures in an answer that do not appear
  in the cited memories.
- **Reindexes itself** when you change the embedding model.

## Architecture

```
Person ─► Agent ─► its LLM
            │ MCP (streamable HTTP or stdio, one token per owner)
            ▼
   deizmem: mcp · worker · cli
            │
   Postgres 17 + pgvector      blobs on disk (sha256)
            ▲
   optional lanes by URL: documents · ocr · whisper · embed
```

Everything runs in containers and targets a **Raspberry Pi 4** (arm64, 8 GB). The heaviest
piece is `embed` (~650 MB of RAM at rest). With all four lanes, the images take about 3 GB of
disk.

| Service | What it is |
|---|---|
| `postgres` | Postgres 17 with pgvector |
| `migrate` | applies migrations and creates the first owner, then exits |
| `worker` | reads files, chunks, embeds and reindexes |
| `mcp` | the agent's interface, at `127.0.0.1:4319/mcp` |
| `documents` | markitdown |
| `ocr` | RapidOCR on ONNX Runtime |
| `whisper` | faster-whisper (`base` by default) |
| `embed` | `paraphrase-multilingual-MiniLM-L12-v2` on ONNX (384 dimensions) |

## Getting started

Requirements: Docker with Compose.

```bash
echo "DM_DB_PASSWORD=$(openssl rand -hex 16)" > .env
mkdir -p data/blobs data/pg data/models
docker network create --internal deizmem_mcp   # once: the network the agent comes in through
docker compose up -d --build
docker compose exec worker node /app/dm.js doctor
```

`doctor` shows each lane (`ok`, `FAIL` or `off`), the queue, and the state of the vectors. On
first start, `embed` and `whisper` download their models into `data/models`.

### On a Raspberry Pi, from another machine

`scripts/pi.sh` syncs the repo over rsync and drives compose on the Pi:

```bash
export DM_PI=user@my-pi          # plus DM_PI_DIR if it isn't Dev/deizmem
scripts/pi.sh up                 # sync and start
scripts/pi.sh dm doctor          # any CLI command
scripts/pi.sh push ~/policy.pdf  # capture a local file
scripts/pi.sh logs worker
```

Images are built on the Pi, so they come out native arm64.

## Connecting an agent

1. **Pair.** The code lasts 15 minutes and the token is shown only once:

   ```bash
   dm pair                             # → code ABCD2345
   dm token ABCD2345 --label hermes    # → dm_…
   ```

2. **Configure the agent** with the endpoint and the token as a `Bearer`. In Hermes Agent
   (`config.yaml`), with the token in an environment variable rather than in the file:

   ```yaml
   mcp_servers:
     deizmem:
       url: "http://deizmem-mcp:4319/mcp"
       headers:
         Authorization: "Bearer ${DEIZMEM_MCP_TOKEN}"
       timeout: 180
   ```

   If the agent runs in another container, attach it to the `deizmem_mcp` network: there `mcp`
   answers as `deizmem-mcp`, and nothing else of deizmem is visible. From the host, the
   endpoint is `http://127.0.0.1:4319/mcp`.

3. **Install the skill** [`skills/deizmem/SKILL.md`](skills/deizmem/SKILL.md) in the agent. It
   carries the rules (cite, verify figures, flag stale data before the value) and the
   workflow. The MCP server sends the same rules in its `instructions` field.

To cut access: `dm sessions`, then `dm revoke <id>`.

### MCP tools

| Tool | Purpose |
|---|---|
| `memory_capture` | store a file (base64) or a note; `text` if the agent already has the content |
| `memory_retrieve` | passages that answer a question, with a `memoryId` to cite |
| `memory_search` · `memory_get` · `memory_original` | list, view details, download the original |
| `memory_set_text` · `memory_hide` | supply the text of something unreadable; hide |
| `pending_list` | the agent's queue: `needs_text`, `unclassified`, `unextracted`, `review`, `failed` |
| `domains_list` · `memory_classify` | categories (their description is the prompt), and classify |
| `fact_types_list` · `facts_put` · `facts_query` | hard facts with evidence and validity |
| `verify` | figures in an answer that are not in what was read |
| `domain_*` · `fact_type_*` | change the registry; require `confirm: true` |

No tool takes an owner: it comes from the token. There is no `purge` and no maintenance over
MCP.

## CLI

```
dm init · doctor · migrate · owners · worker · mcp [--stdio]
dm capture <file> | --text "…" | -   [--note --title --occurred --filename --wait]
dm ls [query] · search <question> · show <id> · open <id> · hide · unhide · text <id> "<text>"
dm pending [kind] · reprocess [--status … | --all | --by <agent>]
dm domains [create|edit|archive|merge] · classify <id> <domain>
dm types [create|edit|archive] · facts <type> · facts put <id> <json> · verify "<text>" <ids…>
dm index [--status] · pair · token <code> · sessions · revoke <id>
```

Global flags: `--json` and `--actor <owner>`. Exit codes: `0` ok · `1` error ·
`2` needs confirmation (`--yes`) · `3` not found · `4` forbidden · `5` ambiguous prefix.

Ids are accepted in full or as a unique prefix of 6 or more characters.

## Configuration

| Variable | Default | |
|---|---|---|
| `DM_DB_PASSWORD` | `deizmem` | Postgres password (in `.env`) |
| `DM_DOCUMENT_URL` · `DM_VISION_URL` · `DM_AUDIO_URL` · `DM_EMBED_URL` | the compose sidecars | empty = lane off |
| `EMBED_MODEL` | `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` | changing it triggers a reindex |
| `WHISPER_MODEL` | `base` | `small` transcribes better and takes about 3× longer |
| `DM_MAX_UPLOAD_BYTES` | 25 MB | per-file limit |
| `DM_UID` · `DM_GID` | `1000` | host owner of the data directory |
| `DEIZMEM_DATA` | `./data` | Where blobs, Postgres and the models live. Set it to keep state **outside** the checkout, so the repository stays disposable and re-cloning never risks the data (e.g. `/srv/deizmem` alongside `/opt/deizmem`). |

## Development

```bash
npm install
scripts/test-db.sh      # throwaway Postgres on 127.0.0.1:55432
npm test                # unit + integration
npm run typecheck
npm run build           # dist/dm.js, a single file
```

The code is TypeScript. Operations live in `src/core` and import nothing concrete; MCP and the
CLI are adapters in `src/adapters`. The lanes are Python services in `services/`. Migrations
are in `migrations/`.

## Limitations

- **There is no off-site backup yet.** Data lives in `./data`: back it up yourself.
- The rules about prose (cite, verify, flag stale data) are the agent's to follow; the memory
  gives it the evidence but cannot force it.
- Everything the agent reads goes through its LLM. If the data is sensitive, choose the
  agent's model with that in mind.
- The month of a date is the agent's claim: evidence checks the year and the day. `verify`
  does not check units.
- TIFF has no lane, and OCR cannot read handwriting (the agent can, via `memory_set_text`).
