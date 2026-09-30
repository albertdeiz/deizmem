import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { putFacts, queryFacts } from '../../core/facts/facts';
import { FIELD_KINDS } from '../../core/facts/evidence';
import { archiveFactType, createFactType, editFactType, listFactTypes } from '../../core/facts/registry';
import { archiveDomain, classify, createDomain, editDomain, listDomains, mergeDomains } from '../../core/ops/domains';
import { verify } from '../../core/ops/verify';
import type { Actor, Deps } from '../../core/ports';
import { byField, strictTools, toMcp } from './tools';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const confirmField = z.boolean().optional().describe('Only after the person explicitly said yes to the change');
const grounded = z.object({
  value: z.unknown().describe('Canonical: ISO date, plain number, {amount, currency} for money, or text'),
  evidence: z.string().describe('The line copied literally from the memory text, label included'),
});
const field = z.object({
  name: z.string(), kind: z.enum(FIELD_KINDS as [string, ...string[]]),
  label: z.string().optional(), description: z.string().optional(),
});

/** Domains, classification, facts and verify (S3). */
export function registerKnowledgeTools(server: McpServer, deps: Deps, actor: Actor): void {
  const tool = strictTools(server);

  tool('domains_list', {
    description: 'The person\'s categories. Each description is the prompt to classify with.',
    inputSchema: { include_archived: z.boolean().optional() },
  }, async (a) => toMcp({ kind: 'ok', value: { domains: await listDomains(deps, actor, a.include_archived) } }));

  tool('memory_classify', {
    description: 'Record your classification of a memory: domain (slug from domains_list), and optionally title, event date and tags. Set needs_review when unsure.',
    inputSchema: {
      id: z.string(), domain: z.string().nullable().optional(), title: z.string().optional(),
      occurred_at: date.optional(), tags: z.array(z.string()).optional(),
      confidence: z.number().min(0).max(1).optional(), needs_review: z.boolean().optional(), by: byField,
    },
  }, async (a) => toMcp(await classify(deps, actor, {
    id: a.id, domain: a.domain ?? null, title: a.title, occurredAt: a.occurred_at, tags: a.tags,
    confidence: a.confidence, needsReview: a.needs_review, by: a.by,
  })));

  tool('domain_create', {
    description: 'Create a category. Without confirm: true it returns requires_confirmation with what would be created.',
    inputSchema: { slug: z.string(), label: z.string().optional(), description: z.string(), confirm: confirmField },
  }, async (a) => toMcp(await createDomain(deps, actor, a, a.confirm)));

  tool('domain_edit', {
    description: 'Rename or re-describe a category. Memories are not touched. Needs confirm: true.',
    inputSchema: { slug: z.string(), label: z.string().optional(), description: z.string().optional(), confirm: confirmField },
  }, async (a) => toMcp(await editDomain(deps, actor, a.slug, a, a.confirm)));

  tool('domain_archive', {
    description: 'Stop offering a category; its memories stay searchable. Needs confirm: true.',
    inputSchema: { slug: z.string(), confirm: confirmField },
  }, async (a) => toMcp(await archiveDomain(deps, actor, a.slug, a.confirm)));

  tool('domain_merge', {
    description: 'Move every memory of one category into another and archive the first. Needs confirm: true.',
    inputSchema: { from: z.string(), into: z.string(), confirm: confirmField },
  }, async (a) => toMcp(await mergeDomains(deps, actor, a.from, a.into, a.confirm)));

  tool('fact_types_list', {
    description: 'The fact registry: which structured data can be stored and queried, with field descriptions. kind estado = one current value (a policy); periodo = values coexist (monthly statements).',
    inputSchema: { include_archived: z.boolean().optional() },
  }, async (a) => toMcp({ kind: 'ok', value: { types: await listFactTypes(deps, actor, a.include_archived) } }));

  tool('fact_type_create', {
    description: 'Propose a new fact type. estado needs identity_field; many needs identity_field. Needs confirm: true after the person agrees.',
    inputSchema: {
      slug: z.string(), kind: z.enum(['estado', 'periodo']), cardinality: z.enum(['one', 'many']).default('one'),
      description: z.string(), domain_slug: z.string().optional(), fields: z.array(field).min(1),
      identity_field: z.string().optional(), confirm: confirmField,
    },
  }, async (a) => toMcp(await createFactType(deps, actor, {
    slug: a.slug, kind: a.kind, cardinality: a.cardinality, description: a.description,
    domainSlug: a.domain_slug ?? null, fields: a.fields as never, identityField: a.identity_field ?? null,
  }, a.confirm)));

  tool('fact_type_edit', {
    description: 'Change a fact type. Needs confirm: true; the response shows before/after and how many facts it affects.',
    inputSchema: {
      slug: z.string(), kind: z.enum(['estado', 'periodo']).optional(), cardinality: z.enum(['one', 'many']).optional(),
      description: z.string().optional(), domain_slug: z.string().nullable().optional(),
      fields: z.array(field).optional(), identity_field: z.string().nullable().optional(), confirm: confirmField,
    },
  }, async (a) => toMcp(await editFactType(deps, actor, a.slug, {
    kind: a.kind, cardinality: a.cardinality, description: a.description, domainSlug: a.domain_slug,
    fields: a.fields as never, identityField: a.identity_field,
  }, a.confirm)));

  tool('fact_type_archive', {
    description: 'Stop offering a fact type; stored facts stay. Needs confirm: true.',
    inputSchema: { slug: z.string(), confirm: confirmField },
  }, async (a) => toMcp(await archiveFactType(deps, actor, a.slug, a.confirm)));

  tool('facts_put', {
    description: 'Store the facts you extracted from one memory for one type. Every field is checked against the document; failures come back in `rejected` with a reason so you can fix and retry. Re-putting replaces this memory\'s facts of that type. With no type and instances: [] it marks the memory as checked (no type applies).',
    inputSchema: {
      memory_id: z.string(), type: z.string().optional(),
      instances: z.array(z.object({
        fields: z.record(z.string(), grounded),
        valid_from: grounded.optional(), valid_until: grounded.optional(),
        confidence: z.number().min(0).max(1).optional(),
      })),
      by: byField,
    },
  }, async (a) => toMcp(await putFacts(deps, actor, { memoryId: a.memory_id, type: a.type, instances: a.instances as never, by: a.by })));

  tool('facts_query', {
    description: 'Exact structured answers. Each fact has status current | expired | superseded | conflict, its evidence and memoryId. Say expired/superseded BEFORE the value; show both on conflict.',
    inputSchema: {
      type: z.string(), identity: z.string().optional(), at: date.optional(),
      history: z.boolean().optional(), memory_id: z.string().optional(),
    },
  }, async (a) => toMcp(await queryFacts(deps, actor, { type: a.type, identity: a.identity, at: a.at, history: a.history, memoryId: a.memory_id })));

  tool('verify', {
    description: 'Check your drafted answer: returns every figure in `text` that does not appear in the given memories. Fix or drop missing figures before answering.',
    inputSchema: { text: z.string(), memory_ids: z.array(z.string()).min(1) },
  }, async (a) => toMcp(await verify(deps, actor, { text: a.text, memoryIds: a.memory_ids })));
}
