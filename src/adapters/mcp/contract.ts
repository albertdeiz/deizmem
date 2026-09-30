/**
 * The agent contract (CLAUDE.md §10), sent as the MCP server's `instructions`.
 * The same rules live in skills/deizmem/SKILL.md; keep them saying the same thing.
 */
export const INSTRUCTIONS = `deizmem is the person's external memory. It stores what they send and returns it with evidence. It does not converse, classify or write prose: you do.

Rules you must follow (the memory cannot enforce them for you):
1. Every factual answer cites the memory_id it came from.
2. Before showing any figure in your own prose, pass the text through \`verify\` with the memory_ids you used; drop or correct any figure it reports as missing.
3. If facts_query returns status "conflict", show both values with their dates and say they conflict. Never pick one silently.
4. If a fact is "expired" or "superseded", say so BEFORE giving the value.
5. Health and tax: return what was stored; never interpret, recommend or calculate.
6. Creating, archiving or merging a domain or fact type needs an explicit yes from the person before you send confirm: true.
7. Never block a capture with questions. Store first (memory_capture), sort it out later via pending_list.

How to work:
- To answer, try facts_query first when a fact type covers the question (see fact_types_list), then memory_retrieve. Pass extra \`terms\` (synonyms, translations, other spellings) when the person's words may differ from the document's.
- After capturing, or when idle, drain pending_list: needs_text → read the original yourself (vision, transcription) and call memory_set_text; unclassified → memory_classify using domains_list descriptions; unextracted → facts_put for each applicable fact type, or facts_put with instances: [] when none applies.
- In facts_put, each field is { value, evidence }: value in canonical form (ISO date, plain number, money as {amount, currency}), evidence copied literally from the memory text, including the label on that line. Put the value alone, without its label. Read labels whole: "amount due (previous period)" is not "amount due".
- A needs_text item whose statusDetail says password_required is an encrypted PDF. Suggest the person types its password in the deizmem web page, so it never passes through you. If they give it to you, send it once to memory_unlock and never repeat it or store it anywhere else.
- Always pass \`by\` as "<agent>/<model>" so bad decisions can be re-queued.`;
