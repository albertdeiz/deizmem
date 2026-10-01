---
name: deizmem
description: Use the person's external memory (deizmem MCP server) to store files and notes they send, and to answer questions about their documents — policies, prescriptions, receipts, IDs, statements — with citations. Use whenever they send a file, ask to remember something, or ask about something they may have stored.
---

# deizmem — the person's external memory

deizmem stores what the person sends and gives it back **with evidence**. It does not
converse, classify or write prose: you do. It never runs an LLM, so every judgement
(which category, which facts, what the answer is) is yours, and every fact you store is
checked against the document before it is accepted.

## Rules (the memory cannot enforce these for you)

1. **Cite.** Every factual answer names the memory it came from (`memoryId`).
2. **Verify figures.** Before sending an answer with numbers, call `verify` with your draft
   and the memory ids you used. Fix or drop every figure it reports as missing.
3. **Conflicts.** If `facts_query` returns `conflict`, show both values with their dates
   and say they conflict. Never pick one silently.
4. **Stale data first.** If a fact is `expired` or `superseded`, say so *before* the value.
5. **Health and tax:** return what was stored. Never interpret, recommend or calculate.
6. **Registry changes need a yes.** Creating, renaming, archiving or merging a domain or
   fact type returns `requires_confirmation`; ask the person, and only then resend with
   `confirm: true`.
7. **Ask before a file enters the memory; never block it afterwards.** Whether something
   is stored is the person's call: ask once, in one short question, and wait. Once they say
   yes, store immediately — do not hold the capture back for metadata questions. One
   clarifying question at most, and it comes *after* storing.
8. **Passwords and 2FA codes do not go here.** Point the person to their password manager.
   The one exception is the password of a PDF they stored: it goes to `memory_unlock` (or
   `password` in `memory_capture`) and nowhere else — never in a `note`, `text`, fact or
   title, and never repeated in your reply. The memory uses it once and does not keep it.

## Capturing

- A file arrives → **ask whether it goes into the memory**, and wait for the answer.
  One short question, e.g. "¿Lo guardo en deizmem?". Nothing is stored until they say yes.
  - **yes** → store **the file itself**, with the person's words as `note`. Do not wait for
    it to be read. Pick the first route that applies:
    1. **The file is on your disk** (an attachment cache, a download) and you share a
       directory with the memory → copy it there and call `memory_capture` with its absolute
       `path` as the server sees it (e.g. `cp <file> /inbox/poliza.pdf`, then
       `path: "/inbox/poliza.pdf"`). Anything outside that directory is refused. This is
       the default: the bytes never pass through your context.
    2. **No shared directory, but you can run a command** → send the bytes from disk to
       `POST /capture`, next to the `/mcp` endpoint and with the same token:
       `curl --data-binary @file -H "Authorization: Bearer $TOKEN" "<base>/capture?filename=…&note=…"`.
       It answers like `memory_capture`.
    3. **Only a file of a few KB, and neither of the above** → `content_base64` with
       `filename`. Beyond a few KB you cannot copy base64 exactly: do not try.
  - **Do not extract the text yourself and store it as `text` while you have the file.** No
    browser, no CDN library, no hand-made PDF reader: the memory reads the file with its own
    lanes, keeps the original, and its text is complete. Storing your extract instead loses
    the original and whatever you cut. Only if every route above failed, store the text
    *and* tell the person which route failed and with which error.
  - Never send a `filename` without the file: it is rejected.
  - An argument the tool does not list is an error, not ignored. If a capture fails, it did
    not store anything: fix the call, do not assume it went through.
  - **no** → do not store it, do not ask again for that file, and do not read it "just in
    case". A file the person declined is not context.
  - The question is about *this* file. Do not generalise a yes or a no to later ones.
- `text` is for content that has no file (something the person typed or dictated to you):
  the memory skips its own lanes. When there is a file, capture the file; if the memory
  cannot read it (`needs_text`), put your own reading (vision, transcription) on that memory
  with `memory_set_text`.
- Pass `occurred_at` when the date of the event is obvious from the conversation.

## Answering

1. Look at `fact_types_list`. If a type covers the question ("what is my deductible?",
   "when does my licence expire?"), call `facts_query` first: it is exact.
2. Otherwise `memory_retrieve`. Add `terms` with synonyms, translations or other spellings
   when the person's words may differ from the document's. Narrow with `domain`, `from`, `to`.
3. `vector: "rebuilding"` or `"off"` means only lexical search ran — try more `terms`.
4. Draft the answer, `verify` it, then reply: the datum, its date, and where it came from.
   If nothing backs it, say you do not have it. Offer the original with `memory_original`.

## Keeping the memory useful (when idle, or right after a capture)

Call `pending_list` and work through it:

| reason | what to do |
|---|---|
| `needs_text` | No lane could read it. `memory_original`, read it yourself (vision / transcription), then `memory_set_text`. If `statusDetail` says `password_required`, the PDF is encrypted: see below. |
| `unclassified` | `domains_list`, pick the domain whose description fits, `memory_classify` (add a title and `occurred_at`). If none fits, propose a new domain to the person. |
| `unextracted` | For each fact type that applies, `facts_put`. If none applies, `facts_put` with no type and `instances: []`. If documents of a recurring kind have no type, propose one to the person. |
| `review` | Something you flagged as doubtful: ask the person when convenient. |

Always pass `by` as `"<agent>/<model>"` (e.g. `"hermes/gpt-5.4"`), so a bad model's
decisions can be re-queued later.

## Encrypted PDFs

A `needs_text` whose `statusDetail` says `password_required` is a PDF with a password. You
cannot read it either, so do not try `memory_original`.

- Tell the person, and **suggest they type the password in the deizmem web page** (the
  memory's detail, "Abrir con contraseña"): that way it never passes through you or your
  model's provider.
- If they give it to you anyway, call `memory_unlock` with it, once. Do not repeat it, do not
  store it anywhere else, and do not keep it for later files.
- `wrong_password` → say so and ask again; `unavailable` → a lane is down, try later.
- When the person sends a PDF together with its password, `memory_capture` takes `password`
  (or `POST /capture` with the header `x-dm-password`, percent-encoded). A wrong one still
  stores the file; the answer's `unlock` says why it was not read.

## Extracting facts well

Each field is `{ "value": ..., "evidence": "..." }`:

- **value** is canonical: `YYYY-MM-DD` dates, plain numbers (`1747885`, not `1.747.885`),
  money as `{ "amount": 5, "currency": "UF" }`, text without its label (`BP9344586`, not
  `póliza N° BP9344586`).
- **evidence** is copied literally from the memory text: the whole line, label included.
  A value of 1–2 characters (a seat "4") is only accepted with its label in the evidence.
- **Read labels whole.** `AMOUNT DUE (PREVIOUS PERIOD) $886.568` is not `TOTAL AMOUNT DUE
  $1.747.885`; both numbers are in the document, and only you can tell which is which.
- Put validity in `valid_from` / `valid_until`, each grounded the same way. For `estado`
  types, the memory computes supersession and conflicts from those dates.
- Rejected fields come back with a reason: fix the value or the evidence and put again.
  Re-putting a type for a memory replaces its previous facts of that type.

## Fact type kinds

- `estado`: one current value per identity (a car policy: the new one supersedes the old).
- `periodo`: values coexist (July's statement stays true about July).
- `cardinality: many`: several instances per document (two passengers on one ticket);
  needs an `identity_field`.
- Not a fact type: anything you would need to **sum** ("how much did I spend on
  delivery"). That is a finance app, not a memory.
