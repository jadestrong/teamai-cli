import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { parseDocument, stringify, type Document } from 'yaml';
import { z } from 'zod';

import { writeFileAtomic } from './utils/fs.js';
import { codeFileId } from './wiki-engine/code-knowledge/code-identity.js';
import { matchHttpContracts, httpContractCoverage, httpMatchesToGraphEdges, normalizeHttpPath, type HttpContractMatch, type HttpRequestContract, type HttpEndpointContract } from './wiki-engine/code-knowledge/http-contract.js';
import { loadGraphIndex, mergeGraphs, parseGraphIndex, saveGraphIndex, type GraphIndex } from './wiki-engine/core/graph-index.schema.js';

export const HTTP_ROUTING_FILE = 'http-routing.yaml';

const BackendSchema = z.object({ origin: z.string().min(1), service: z.string().min(1) }).strict();
const RouteSchema = z.object({
  path: z.string().min(1).nullable(),
  rewrite: z.string().nullable(),
  backend: BackendSchema.nullable(),
  priority: z.number().int().optional(),
}).strict();
const ClientSchema = z.object({
  definition: z.string().min(1),
  routes: z.array(RouteSchema),
  requests: z.array(z.unknown()).optional(),
}).strict();
const ConfigSchema = z.object({
  version: z.literal(1),
  frontends: z.array(z.object({ origin: z.string().min(1), clients: z.array(ClientSchema) }).strict()),
  backends: z.array(z.object({ origin: z.string(), service: z.string().nullable(), endpointCount: z.number(), samplePaths: z.array(z.string()) }).strict()).optional(),
}).strict();
export type HttpRoutingConfig = z.infer<typeof ConfigSchema>;
type Rule = { origin: string; definition: string; route: z.infer<typeof RouteSchema>; pattern: RegExp; pointer: string };
export interface HttpRouting {
  config: HttpRoutingConfig;
  hash: string;
  rules: Rule[];
}

export class HttpRoutingError extends Error {}

function compile(config: HttpRoutingConfig): HttpRouting {
  const rules: Rule[] = [];
  const clients = new Set<string>();
  const origins = config.frontends.map((frontend) => frontend.origin);
  if (new Set(origins).size !== origins.length) throw new HttpRoutingError('Each frontend origin must appear once; group its clients together.');
  for (const frontend of config.frontends) for (const client of frontend.clients) {
    // A client definition is a repository-relative file identity, never a host.
    try { codeFileId(frontend.origin, client.definition); } catch (error) { throw new HttpRoutingError(String(error)); }
    const key = JSON.stringify([frontend.origin, client.definition]);
    if (clients.has(key)) throw new HttpRoutingError(`Duplicate HTTP client: ${key}`);
    clients.add(key);
    for (const [index, route] of client.routes.entries()) {
      if (route.path === null || route.rewrite === null || route.backend === null) continue;
      if (!route.path.startsWith('/') && !route.path.startsWith('^/')) throw new HttpRoutingError(`HTTP route must start with /: ${route.path}`);
      let pattern: RegExp;
      try { pattern = new RegExp(`^(?:${route.path})$`, 'u'); }
      catch (error) { throw new HttpRoutingError(`Invalid HTTP route ${route.path}: ${String(error)}`); }
      // The empty alternative lets us count capture slots without matching a URL.
      const captures = new RegExp(`(?:${route.path})|`, 'u').exec('')!.length - 1;
      for (const slot of route.rewrite.matchAll(/\$(\d+)/gu)) {
        if (Number(slot[1]) > captures) throw new HttpRoutingError(`Rewrite references missing capture $${slot[1]}: ${route.path}`);
      }
      rules.push({ origin: frontend.origin, definition: client.definition, route, pattern, pointer: `${frontend.origin}/${client.definition}/routes/${index}` });
    }
  }
  const hash = createHash('sha256').update(JSON.stringify(rules.map(({ origin, definition, route }) => ({ origin, definition, route })))).digest('hex');
  return { config, rules, hash };
}

function document(raw: string): { doc: Document; routing: HttpRouting } {
  const doc = parseDocument(raw, { uniqueKeys: true });
  if (doc.errors.length) throw new HttpRoutingError(`Invalid ${HTTP_ROUTING_FILE}: ${doc.errors.map((e) => e.message).join('; ')}`);
  const result = ConfigSchema.safeParse(doc.toJS());
  if (!result.success) throw new HttpRoutingError(`Invalid ${HTTP_ROUTING_FILE}: ${result.error.message}`);
  return { doc, routing: compile(result.data) };
}

export async function loadHttpRouting(wikiRoot: string): Promise<HttpRouting | undefined> {
  let raw: string;
  try { raw = await readFile(path.join(wikiRoot, HTTP_ROUTING_FILE), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new HttpRoutingError(`Cannot read ${HTTP_ROUTING_FILE}: ${String(error)}`);
  }
  return document(raw).routing;
}

/** A configured route can resolve a dynamic host, but cannot invent a URL or method. */
export function matchRoutedHttpContracts(requests: HttpRequestContract[], endpoints: HttpEndpointContract[], routing?: HttpRouting): HttpContractMatch[] {
  if (!routing?.rules.length) return matchHttpContracts(requests, endpoints);
  return requests.map((request) => {
    if (!request.path || !request.method || (request.unresolvedReason && !['Dynamic API host', 'Dynamic baseURL'].includes(request.unresolvedReason))) {
      return matchHttpContracts([request], endpoints)[0];
    }
    const applicable = routing.rules.filter((rule) => rule.origin === request.origin
      && rule.definition === (request.clientDefinition ?? request.file) && rule.pattern.test(request.path));
    if (!applicable.length) return matchHttpContracts([request], endpoints)[0];
    const priority = Math.max(...applicable.map((rule) => rule.route.priority ?? 0));
    const selected = applicable.filter((rule) => (rule.route.priority ?? 0) === priority);
    if (selected.length !== 1) return { request, confidence: 'AMBIGUOUS', reason: 'Multiple matching proxy routes' };
    const rule = selected[0];
    const captures = rule.pattern.exec(request.path)!;
    const rewritten = rule.route.rewrite!.replace(/\$(\d+)/gu, (_, slot: string) => captures[Number(slot)] ?? '');
    if (!rewritten.startsWith('/')) return { request, confidence: 'AMBIGUOUS', reason: 'Proxy rewrite did not produce an absolute path' };
    const backend = rule.route.backend!;
    const resolved = { ...request, path: normalizeHttpPath(rewritten), service: backend.service, unresolvedReason: undefined };
    const match = matchHttpContracts([resolved], endpoints.filter((endpoint) => endpoint.origin === backend.origin));
    return {
      ...match[0], request,
      resolution: {
        path: resolved.path, service: backend.service, backendOrigin: backend.origin,
        evidence: [{ ref: HTTP_ROUTING_FILE, type: 'config', note: `${rule.pointer}: ${request.path} -> ${resolved.path} -> ${backend.origin}/${backend.service}; routing sha256=${routing.hash}` }],
      },
    };
  });
}

/** Replaces only derived HTTP state; source observations and all other relations survive. */
export function applyHttpRouting(graph: GraphIndex, routing?: HttpRouting): GraphIndex {
  const contracts = graph.httpContracts;
  if (!contracts) return graph;
  const matches = matchRoutedHttpContracts(contracts.requests, contracts.endpoints, routing);
  const totals = contracts.coverage ?? httpContractCoverage(0, 0, contracts.requests, contracts.endpoints, matches);
  const coverage = httpContractCoverage(totals.filesScanned, totals.filesParsed, contracts.requests, contracts.endpoints, matches, totals.filesFailed, totals.filesUnsupported);
  const base = { ...graph, edges: graph.edges.filter((edge) => edge.relation !== 'CALLS_HTTP'), httpContracts: undefined };
  const merged = mergeGraphs(base, { ...base, nodes: [], edges: httpMatchesToGraphEdges(matches) });
  merged.generatedAt = graph.generatedAt;
  merged.httpContracts = { ...contracts, matches, coverage, routingHash: routing?.hash };
  return merged;
}

function linksMarkdown(graph: GraphIndex): string {
  const matches = graph.httpContracts?.matches ?? [];
  const linked = matches.filter((match) => match.confidence === 'EXTRACTED' && match.endpoint);
  const cell = (text: string) => text.replace(/\|/gu, '\\|').replace(/[\r\n]/gu, ' ');
  const configuration = graph.httpContracts?.routingHash
    ? `Routing configuration: [${HTTP_ROUTING_FILE}](${HTTP_ROUTING_FILE}).`
    : 'No HTTP routing configuration. Run `teamai codebase --init-http-routing` to generate one.';
  const lines = ['# Frontend / backend HTTP links', '', `${linked.length} uniquely matched request observations; ${matches.length - linked.length} remain unresolved or ambiguous.`, '', `${configuration} Unconfigured requests keep their extracted behavior.`, '', '| Frontend source | Request | Backend service | Backend path | Backend source | Routing evidence |', '|---|---|---|---|---|---|'];
  for (const match of linked) {
    const r = match.request, e = match.endpoint!;
    lines.push(`| ${cell(`${codeFileId(r.origin, r.file)}:${r.line}`)} | ${cell(`${r.method} ${r.path}`)} | ${cell(e.service ?? '')} | ${cell(match.resolution?.path ?? e.path)} | ${cell(`${codeFileId(e.origin, e.file)}:${e.line}`)} | ${match.resolution ? HTTP_ROUTING_FILE : 'Source contract'} |`);
  }
  return lines.join('\n') + '\n';
}

export async function writeHttpLinks(wikiRoot: string, graph: GraphIndex): Promise<void> {
  if (!graph.httpContracts) return;
  const file = path.join(wikiRoot, 'http-links.md');
  const text = linksMarkdown(graph);
  if (await readFile(file, 'utf8').catch(() => null) !== text) await writeFileAtomic(file, text);
}

export async function refreshHttpRouting(wikiRoot: string, dryRun = false): Promise<{ updated: boolean; uniqueMatches: number }> {
  const graph = await loadGraphIndex(wikiRoot);
  const routing = await loadHttpRouting(wikiRoot);
  if (!graph) {
    if (!routing) return { updated: false, uniqueMatches: 0 };
    throw new HttpRoutingError('No v2 global graph found. Run `teamai import` first.');
  }
  const next = applyHttpRouting(graph, routing);
  const updated = !isDeepStrictEqual(JSON.parse(JSON.stringify(graph)), JSON.parse(JSON.stringify(next)));
  if (!dryRun) {
    if (updated) { next.generatedAt = new Date().toISOString(); await saveGraphIndex(wikiRoot, next); }
    await writeHttpLinks(wikiRoot, next);
  }
  return { updated, uniqueMatches: next.httpContracts?.coverage?.uniqueMatches ?? 0 };
}

/** Lists every imported request and backend without guessing service assignments. */
export async function initHttpRouting(wikiRoot: string, dryRun = false): Promise<{ file: string; frontends: number; clients: number; requests: number; backends: number; updated: boolean }> {
  const codeRoot = path.join(wikiRoot, 'evidence', 'code');
  const entries = await readdir(codeRoot, { withFileTypes: true }).catch(() => []);
  const requests: HttpRequestContract[] = [], endpoints: HttpEndpointContract[] = [];
  let imported = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const raw = await readFile(path.join(codeRoot, entry.name, '.indices', 'graph-index.json'), 'utf8').catch(() => null);
    if (!raw) continue;
    const graph = parseGraphIndex(JSON.parse(raw));
    if (!graph) throw new HttpRoutingError(`Re-import ${entry.name}: its graph is not v2.`);
    imported++;
    requests.push(...graph.httpContracts?.requests ?? []); endpoints.push(...graph.httpContracts?.endpoints ?? []);
  }
  if (!imported) throw new HttpRoutingError('No imported repository graphs found. Run `teamai import` first.');
  const file = path.join(wikiRoot, HTTP_ROUTING_FILE);
  const raw = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  const existing = raw === null ? undefined : document(raw);
  const config: HttpRoutingConfig = existing?.routing.config ?? { version: 1, frontends: [] };
  const doc = existing?.doc ?? parseDocument(stringify(config));
  if (!existing) doc.commentBefore = ' HTTP routing configuration. Null rewrite/backend values are inactive.\n Fill targets from the backend inventory; rewrite "$0" preserves the path.\n Patterns match the full path. Higher priority wins; equal priorities are ambiguous.\n Requests without clientDefinition in older graphs are grouped by caller file.\n Re-run --init-http-routing to refresh inventory without replacing your rules.';
  // Refresh generated inventory, while preserving user routes and YAML comments.
  for (const [fi, frontend] of config.frontends.entries()) for (const [ci] of frontend.clients.entries()) doc.setIn(['frontends', fi, 'clients', ci, 'requests'], []);
  for (const request of requests) {
    let fi = config.frontends.findIndex((frontend) => frontend.origin === request.origin);
    if (fi < 0) {
      fi = config.frontends.length; config.frontends.push({ origin: request.origin, clients: [] });
      doc.addIn(['frontends'], doc.createNode({ origin: request.origin, clients: [] }));
    }
    const frontend = config.frontends[fi], definition = request.clientDefinition ?? request.file;
    let ci = frontend.clients.findIndex((client) => client.definition === definition);
    if (ci < 0) {
      ci = frontend.clients.length; frontend.clients.push({ definition, routes: [], requests: [] });
      doc.addIn(['frontends', fi, 'clients'], doc.createNode({ definition, routes: [], requests: [] }));
    }
  }
  for (const [fi, frontend] of config.frontends.entries()) for (const [ci, client] of frontend.clients.entries()) {
    const observed = requests.filter((r) => r.origin === frontend.origin && (r.clientDefinition ?? r.file) === client.definition);
    const inventory = observed.map((r) => ({ method: r.method || null, path: r.path || null, reason: r.unresolvedReason ?? null, source: `${r.file}:${r.line}` }));
    doc.setIn(['frontends', fi, 'clients', ci, 'requests'], inventory);
    // Suggested prefix patterns never become active without a user's rewrite and backend.
    const patterns = new Set(observed.flatMap((r) => {
      const segment = /^\/([\w-]+)/u.exec(r.path)?.[1];
      return segment ? [`/${segment}(?:/|$)(.*)`] : [];
    }));
    for (const pattern of patterns) if (!client.routes.some((route) => route.path === pattern)) {
      const pending = { path: pattern, rewrite: null, backend: null };
      doc.addIn(['frontends', fi, 'clients', ci, 'routes'], doc.createNode(pending)); client.routes.push(pending);
    }
    if (!client.routes.length && observed.length) doc.addIn(['frontends', fi, 'clients', ci, 'routes'], doc.createNode({ path: null, rewrite: null, backend: null }));
  }
  const backends = [...new Set(endpoints.map((e) => JSON.stringify([e.origin, e.service ?? null])))].map((key) => {
    const [origin, service] = JSON.parse(key) as [string, string | null];
    const found = endpoints.filter((e) => e.origin === origin && (e.service ?? null) === service);
    return { origin, service, endpointCount: found.length, samplePaths: [...new Set(found.map((e) => e.path))].slice(0, 5) };
  });
  doc.set('backends', backends);
  const text = doc.toString();
  document(text); // Validate before replacing an existing user-owned file.
  if (!dryRun && text !== raw) await writeFileAtomic(file, text);
  return { file, frontends: config.frontends.length, clients: config.frontends.reduce((n, f) => n + f.clients.length, 0), requests: requests.length, backends: backends.length, updated: text !== raw };
}
