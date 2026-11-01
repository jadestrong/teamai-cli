import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';

import { applyHttpRouting, initHttpRouting, loadHttpRouting, matchRoutedHttpContracts, refreshHttpRouting, type HttpRoutingConfig } from '../http-routing.js';
import { createGraphIndex, loadGraphIndex, mergeGraphs, saveGraphIndex } from '../wiki-engine/core/graph-index.schema.js';
import { httpContractCoverage, matchHttpContracts, type HttpRequestContract } from '../wiki-engine/code-knowledge/http-contract.js';
import { lintTeamwiki } from '../codebase-wiki-lint.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function temp() { const root = await mkdtemp(path.join(os.tmpdir(), 'teamai-http-routing-')); roots.push(root); return root; }
const request = (overrides: Partial<HttpRequestContract> = {}): HttpRequestContract => ({ origin: 'web', file: 'request.ts', line: 1, method: 'GET', path: '/funding/plans/{id}', clientDefinition: 'TRADE.ts', unresolvedReason: 'Dynamic API host', ...overrides });
const endpoint = (origin = 'api', service = 'funding-site', file = 'Site.java') => ({ origin, file, line: 2, methods: ['GET'], path: '/plans/{planId}', service });
const route = (overrides = {}) => ({ path: '/funding/(.*)', rewrite: '/$1', backend: { origin: 'api', service: 'funding-site' }, ...overrides });
const config = (routes = [route()]): HttpRoutingConfig => ({ version: 1, frontends: [{ origin: 'web', clients: [{ definition: 'TRADE.ts', routes }] }] });
async function routing(root: string, value: unknown = config()) { await writeFile(path.join(root, 'http-routing.yaml'), stringify(value)); return loadHttpRouting(root); }
async function imported(root: string, origin: string, requests = [request()], endpoints: ReturnType<typeof endpoint>[] = []) {
  const graph = createGraphIndex([...requests, ...endpoints].map((r) => ({ slug: `code://${r.origin}/${r.file}`, path: r.file, origin: r.origin, title: r.file, type: 'component' as const, confidence: 'EXTRACTED' as const })));
  const matches = matchHttpContracts(requests, endpoints);
  graph.httpContracts = { requests, endpoints, matches, coverage: httpContractCoverage(1, 1, requests, endpoints, matches), coverageByOrigin: { [origin]: httpContractCoverage(1, 1, requests, endpoints, matches) } };
  const dir = path.join(root, 'evidence', 'code', origin);
  await mkdir(path.join(dir, '.indices'), { recursive: true });
  await writeFile(path.join(dir, '.indices', 'graph-index.json'), JSON.stringify(graph));
  return graph;
}

describe('HTTP routing configuration', () => {
  it('routes one frontend client to multiple services and retains original observations', async () => {
    const root = await temp();
    const rules = await routing(root, config([route(), route({ path: '/bos/(.*)', backend: { origin: 'bos', service: 'funding-bos' } })]));
    const requests = [request(), request({ path: '/bos/plans/{id}' }), request({ path: '/other/plans/{id}' })];
    const matches = matchRoutedHttpContracts(requests, [endpoint(), endpoint('bos', 'funding-bos', 'Bos.java')], rules);
    expect(matches.map((m) => m.confidence)).toEqual(['EXTRACTED', 'EXTRACTED', 'AMBIGUOUS']);
    expect(matches[0]).toMatchObject({ request: requests[0], resolution: { path: '/plans/{id}', service: 'funding-site', backendOrigin: 'api' } });
    expect(matches[1].endpoint?.origin).toBe('bos');
    expect(requests[0].unresolvedReason).toBe('Dynamic API host');
  });

  it('isolates client definitions, frontend origins and backend origins', async () => {
    const rules = await routing(await temp());
    expect(matchRoutedHttpContracts([request()], [endpoint(), endpoint('other')], rules)[0].endpoint?.origin).toBe('api');
    for (const r of [request({ origin: 'other' }), request({ clientDefinition: 'OTHER.ts' })]) {
      expect(matchRoutedHttpContracts([r], [endpoint()], rules)[0].confidence).toBe('AMBIGUOUS');
    }
  });

  it('retains two clients calling the same path on the same source line during graph merging', async () => {
    const root = await temp();
    const first = await imported(root, 'web', [request()]);
    const second = await imported(root, 'web', [request({ clientDefinition: 'OTHER.ts' })]);
    const merged = mergeGraphs(first, second);
    expect(merged.httpContracts?.requests).toHaveLength(2);
    const cfg = config();
    cfg.frontends[0].clients.push({ definition: 'OTHER.ts', routes: [route({ backend: { origin: 'bos', service: 'funding-bos' } })] });
    const rules = await routing(root, cfg);
    const matches = matchRoutedHttpContracts(merged.httpContracts!.requests, [endpoint(), endpoint('bos', 'funding-bos')], rules);
    expect(matches.map((m) => m.endpoint?.origin)).toEqual(['api', 'bos']);
  });

  it('ignores incomplete rules and keeps existing static matches', async () => {
    const root = await temp();
    const rules = await routing(root, { version: 1, frontends: [{ origin: 'web', clients: [{ definition: 'TRADE.ts', routes: [{ path: '/plans/(.*)', rewrite: null, backend: null }] }] }] });
    const r = request({ path: '/plans/{id}', service: 'funding-site', unresolvedReason: undefined });
    expect(matchRoutedHttpContracts([r], [endpoint()], rules)[0].confidence).toBe('EXTRACTED');
  });

  it('keeps conflicting rules ambiguous until one has higher priority', async () => {
    const root = await temp();
    let rules = await routing(root, config([route(), route({ backend: { origin: 'bos', service: 'funding-bos' } })]));
    const endpoints = [endpoint(), endpoint('bos', 'funding-bos')];
    expect(matchRoutedHttpContracts([request()], endpoints, rules)[0]).toMatchObject({ reason: 'Multiple matching proxy routes', confidence: 'AMBIGUOUS' });
    rules = await routing(root, config([route({ priority: 1 }), route({ backend: { origin: 'bos', service: 'funding-bos' } })]));
    expect(matchRoutedHttpContracts([request()], endpoints, rules)[0].endpoint?.origin).toBe('api');
  });

  it('supports capture rewrites and path preservation without partial prefix matches', async () => {
    const root = await temp();
    const rules = await routing(root, config([route({ path: '/(funding.*)', rewrite: '$0' })]));
    const e = { ...endpoint(), path: '/funding/plans/{planId}' };
    expect(matchRoutedHttpContracts([request()], [e], rules)[0].confidence).toBe('EXTRACTED');
    expect(matchRoutedHttpContracts([request({ path: '/other/funding/plans/{id}' })], [e], rules)[0].confidence).toBe('AMBIGUOUS');
  });

  it.each([
    { path: '', unresolvedReason: 'Dynamic URL' },
    { method: '', unresolvedReason: 'Dynamic HTTP method' },
    { unresolvedReason: 'Dynamic local URL' },
    { unresolvedReason: 'Unresolved SWR key' },
  ])('does not use routing to invent missing request data: $unresolvedReason', async (overrides) => {
    const rules = await routing(await temp());
    expect(matchRoutedHttpContracts([request(overrides)], [endpoint()], rules)[0].confidence).toBe('AMBIGUOUS');
  });

  it.each([
    config([route({ path: '/funding/(' })]),
    config([route({ rewrite: '/$2' })]),
    { version: 1, frontends: [{ origin: 'web', clients: [{ definition: 'TRADE.ts', routes: [route()], typo: true }] }] },
    { version: 2, frontends: [] },
    { version: 1, frontends: [{ origin: 'web', clients: [{ definition: '../TRADE.ts', routes: [] }] }] },
    { version: 1, frontends: [{ origin: 'web', clients: [] }, { origin: 'web', clients: [] }] },
  ])('rejects invalid configuration rather than silently guessing', async (value) => {
    await expect(routing(await temp(), value)).rejects.toThrow();
  });

  it('removes stale edges when a rule changes or disappears, preserving non-HTTP relations', async () => {
    const root = await temp();
    const graph = await imported(root, 'web', [request()], [endpoint()]);
    graph.edges.push({ from: 'code://web/request.ts', to: 'code://api/Site.java', relation: 'MAPS_TO', source: 'bridge-reconcile' });
    await saveGraphIndex(root, graph);
    await routing(root);
    expect((await refreshHttpRouting(root)).uniqueMatches).toBe(1);
    let saved = (await loadGraphIndex(root))!;
    expect(saved.httpContracts?.requests[0]).toEqual(request());
    expect(saved.edges.find((e) => e.relation === 'CALLS_HTTP')?.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ ref: 'http-routing.yaml', type: 'config' })]));
    expect(await refreshHttpRouting(root)).toMatchObject({ updated: false });
    await rm(path.join(root, 'http-routing.yaml'));
    expect((await refreshHttpRouting(root)).uniqueMatches).toBe(0);
    saved = (await loadGraphIndex(root))!;
    expect(saved.edges.map((e) => e.relation)).toEqual(['MAPS_TO']);
    expect(await readFile(path.join(root, 'http-links.md'), 'utf8')).toContain('0 uniquely matched');
  });

  it('round-trips routing metadata and flags a stale configuration in lint', async () => {
    const root = await temp();
    const graph = await imported(root, 'web', [request()], [endpoint()]);
    const rules = await routing(root);
    await saveGraphIndex(root, applyHttpRouting(graph, rules));
    const saved = (await loadGraphIndex(root))!;
    expect(saved.httpContracts?.matches?.[0].resolution?.backendOrigin).toBe('api');
    expect((await lintTeamwiki({ wikiRoot: root })).issues.filter((e) => e.category.startsWith('http-'))).toEqual([]);
    await routing(root, config([route({ rewrite: '/missing/$1' })]));
    expect((await lintTeamwiki({ wikiRoot: root })).issues.map((e) => e.category)).toContain('http-routing-stale');
  });
});

describe('HTTP routing inventory', () => {
  it('lists all requests and backend services and incrementally preserves routes and comments', async () => {
    const root = await temp();
    await imported(root, 'web', [request(), request({ path: '', line: 3, unresolvedReason: 'Dynamic URL' })]);
    await imported(root, 'api', [], [endpoint(), endpoint('api', 'funding-bos', 'Bos.java')]);
    expect(await initHttpRouting(root, true)).toMatchObject({ clients: 1, requests: 2, backends: 2 });
    await expect(readFile(path.join(root, 'http-routing.yaml'))).rejects.toThrow();
    await initHttpRouting(root);
    const file = path.join(root, 'http-routing.yaml');
    let cfg = parse(await readFile(file, 'utf8')) as HttpRoutingConfig;
    expect(cfg.frontends[0].clients[0].requests).toHaveLength(2);
    expect(cfg.frontends[0].clients[0].routes[0]).toMatchObject({ rewrite: null, backend: null });
    cfg.frontends[0].clients[0].routes = [route()];
    await writeFile(file, '# Keep my routing notes\n' + stringify(cfg));
    await imported(root, 'web', [request(), request({ path: '/withdrawals/wire', line: 4 })]);
    await initHttpRouting(root);
    cfg = parse(await readFile(file, 'utf8')) as HttpRoutingConfig;
    expect(await readFile(file, 'utf8')).toContain('Keep my routing notes');
    expect(cfg.frontends[0].clients[0].routes[0]).toEqual(route());
    expect(cfg.frontends[0].clients[0].routes).toContainEqual({ path: '/withdrawals(?:/|$)(.*)', rewrite: null, backend: null });
    expect(cfg.frontends[0].clients[0].requests).toHaveLength(2);
    expect(await initHttpRouting(root)).toMatchObject({ updated: false });
  });

  it('can scope legacy observations by caller file and never overwrites malformed user YAML', async () => {
    const root = await temp();
    await imported(root, 'web', [request({ clientDefinition: undefined })]);
    await initHttpRouting(root);
    const file = path.join(root, 'http-routing.yaml');
    const cfg = parse(await readFile(file, 'utf8')) as HttpRoutingConfig;
    expect(cfg.frontends[0].clients[0].definition).toBe('request.ts');
    const broken = 'version: 1\nversion: 2\n';
    await writeFile(file, broken);
    await expect(initHttpRouting(root)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(broken);
  });
});
