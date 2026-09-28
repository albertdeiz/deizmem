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

## Capturing

- A file arrives → **ask whether it goes into the memory**, and wait for the answer.
  One short question, e.g. "¿Lo guardo en deizmem?". Nothing is stored until they say yes.
  - **yes** → `memory_capture` with `content_base64`, `filename`, and the person's words as
    `note`. Do not wait for it to be read.
  - **no** → do not store it, do not ask again for that file, and do not read it "just in
    case". A file the person declined is not context.
  - The question is about *this* file. Do not generalise a yes or a no to later ones.
- If you already have the content (you transcribed a voice note, read handwriting with
  vision), send it as `text`: the memory skips its own lanes.
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
| `needs_text` | No lane could read it. `memory_original`, read it yourself (vision / transcription), then `memory_set_text`. |
| `unclassified` | `domains_list`, pick the domain whose description fits, `memory_classify` (add a title and `occurred_at`). If none fits, propose a new domain to the person. |
| `unextracted` | For each fact type that applies, `facts_put`. If none applies, `facts_put` with no type and `instances: []`. If documents of a recurring kind have no type, propose one to the person. |
| `review` | Something you flagged as doubtful: ask the person when convenient. |

Always pass `by` as `"<agent>/<model>"` (e.g. `"hermes/gpt-5.4"`), so a bad model's
decisions can be re-queued later.

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
