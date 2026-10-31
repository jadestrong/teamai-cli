import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractHttpRequests, matchHttpContracts, httpMatchesToGraphEdges, httpContractCoverage } from '../wiki-engine/code-knowledge/http-contract.js';
import { resolveSpringHttpEndpoints } from '../wiki-engine/code-knowledge/http-service-resolver.js';
import type { CodeCollectedFile } from '../wiki-engine/code-knowledge/code-collector.js';
import { extractStructuralGraphAsFacts } from '../wiki-engine/code-knowledge/ast/index.js';
import { createGraphIndex, mergeGraphs, parseGraphIndex, saveGraphIndex } from '../wiki-engine/core/graph-index.schema.js';
import { buildAggregatedGraph, scopeGlobalGraph } from '../graph-aggregate.js';
import { lintTeamwiki } from '../codebase-wiki-lint.js';
import { extractCodebase } from '../codebase-extract.js';
import { reconcileIwikiWithCodebase } from '../import-iwiki.js';
import { queryCodeKnowledge } from '../code-knowledge-recall.js';
import { buildCodeGraph } from '../wiki-engine/code-knowledge/code-graph.js';
import { importLocalCheckout } from '../import-codebase.js';
import { createGit } from '../utils/git.js';

const temporaryDirectories: string[] = [];
async function temp() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'http-graph-validation-'));
  temporaryDirectories.push(root);
  return root;
}
function file(relativePath: string, content: string): CodeCollectedFile {
  return { path: `/virtual/${relativePath}`, relativePath, content, language: relativePath.endsWith('.java') ? 'java' : 'typescript', sha256: 'x' };
}
function node(origin: string, sourcePath: string) {
  return { slug: `code://${origin}/${sourcePath}`, origin, path: sourcePath, title: sourcePath, type: 'component' as const, confidence: 'EXTRACTED' as const };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('HTTP source and graph acceptance', () => {
  it('keeps identical normalized paths in separate repositories distinct', () => {
    const first = buildCodeGraph([], { origin: 'a', files: ['src/../src/Controller.java'] });
    const second = buildCodeGraph([], { origin: 'b', files: ['src/Controller.java'] });
    const graph = mergeGraphs(first, second);
    expect(graph.nodes.map((entry) => entry.slug)).toEqual(['code://a/src/Controller.java', 'code://b/src/Controller.java']);
    expect(graph.edges).toEqual([]);
  });
  it('extracts AMS catalogs through namespace imports and an axios wrapper without inventing a runtime host', async () => {
    const requests = await extractHttpRequests([
      file('http.ts', 'import axios from "axios"; export default axios;'),
      file('define.ts', 'export const defineGET = (url: string) => url;'),
      file('TRADE.ts', 'import { defineGET } from "./define"; export const API = { funding: { swift: defineGET("/funding/bank-swift"), detail: "/funding/:id" } }; export const HOST = isDev ? config.HOST[0] : config.HOST[1];'),
      file('API.ts', 'import * as TRADE from "./TRADE"; const APICollection = { TRADE }; export default Object.keys(APICollection).reduce(enhance, {}) as APIPicker;'),
      file('request.ts', 'import http from "./http"; import API from "./API"; function request(params: Query) { http.get<Result>(API.TRADE.funding.swift(params)); } API.TRADE.funding.detail.get({ id });'),
    ], 'ams');
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.path)).toEqual(['/funding/bank-swift', '/funding/{id}']);
    expect(requests.every((request) => request.unresolvedReason === 'Dynamic API host' && !request.service)).toBe(true);
    expect(requests[0].evidence).toEqual(expect.arrayContaining([expect.objectContaining({ ref: 'code://ams/TRADE.ts' })]));
    const matches = matchHttpContracts(requests, []);
    expect(httpMatchesToGraphEdges(matches)).toEqual([]);
    expect(httpContractCoverage(5, 5, requests, [], matches)).toMatchObject({ requests: 2, unresolved: 2, candidates: 0 });
  });

  it('handles baseURL and generic calls while ignoring a method in a POST payload', async () => {
    const requests = await extractHttpRequests([file('request.ts', `
      import client from 'axios';
      const http = client.create({ baseURL: 'https://funding-site/v1' });
      http.post<Result>('/orders?sort=asc', { method: 'DELETE' });
      client.get('/users', { baseURL: 'https://funding-site' });
      client.post('/dynamic', {}, { baseURL: runtimeHost });
      fetch(dynamicUrl, { method: runtimeMethod });
    `)], 'web');
    expect(requests[0]).toMatchObject({ method: 'POST', service: 'funding-site', path: '/v1/orders' });
    expect(requests[1]).toMatchObject({ service: 'funding-site', path: '/users' });
    expect(requests[2]).toMatchObject({ unresolvedReason: 'Dynamic baseURL' });
    expect(requests[3]).toMatchObject({ unresolvedReason: 'Dynamic HTTP method', method: '', path: '' });
  });

  it('reads updated tsconfig aliases when the same source is extracted again', async () => {
    const root = await temp();
    const modules = [file('a/url.ts', 'export const URL = "https://site/old";'), file('b/url.ts', 'export const URL = "https://site/new";'), file('request.ts', 'import { URL } from "@api/url"; fetch(URL);')];
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@api/*': ['a/*'] } } }));
    expect((await extractHttpRequests(modules, 'web', root))[0].path).toBe('/old');
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@api/*': ['b/*'] } } }));
    expect((await extractHttpRequests(modules, 'web', root))[0].path).toBe('/new');
  });

  it('does not turn an SWR cache key into an HTTP path', async () => {
    const requests = await extractHttpRequests([file('request.ts', 'import { useSWR } from "@tiger/swr"; useSWR("cachedOrders");')], 'web');
    expect(requests[0]).toMatchObject({ unresolvedReason: 'Unresolved SWR key', path: '' });
  });

  it('does not resolve shadowed clients or local URLs from module constants', async () => {
    const requests = await extractHttpRequests([file('request.ts', `
      import axios from 'axios';
      const URL = 'https://site/orders';
      function custom(axios: Client) { axios.get(URL); }
      function local(URL: string) { fetch(URL); }
      let runtimeURL = 'https://site/orders';
      fetch(runtimeURL);
    `)], 'web');
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => !request.service && !!request.unresolvedReason)).toBe(true);
  });

  it('uses module-specific Spring names and prefixes, including a root module', () => {
    const endpoints = resolveSpringHttpEndpoints([
      { file: 'site/src/main/java/Controller.java', line: 1, controller: 'Controller', handler: 'get', paths: ['/orders'], methods: ['GET'], confidence: 'EXTRACTED' },
      { file: 'bos/src/main/java/Controller.java', line: 1, controller: 'Controller', handler: 'get', paths: ['/orders'], methods: ['GET'], confidence: 'EXTRACTED' },
      { file: 'src/main/java/Root.java', line: 1, controller: 'Root', handler: 'get', paths: ['/root'], methods: ['GET'], confidence: 'EXTRACTED' },
    ], [
      file('site/src/main/resources/application.properties', 'spring.application.name=funding-site\nserver.servlet.context-path=/funding\nspring.mvc.servlet.path=/v1'),
      file('bos/src/main/resources/application.yml', 'spring:\n  application:\n    name: funding-bos'),
      file('src/main/resources/application.properties', 'spring.application.name=funding-root'),
    ], 'funding');
    expect(endpoints.map((endpoint) => [endpoint.service, endpoint.path])).toEqual([
      ['funding-site', '/funding/v1/orders'], ['funding-bos', '/orders'], ['funding-root', '/root'],
    ]);
    expect(endpoints[0].evidence).toEqual(expect.arrayContaining([expect.objectContaining({ ref: 'code://funding/site/src/main/resources/application.properties', type: 'config' })]));
  });

  it('does not infer a service for conflicting profiles or dynamic configuration', () => {
    const endpoint = { file: 'src/main/java/Controller.java', line: 1, controller: 'Controller', handler: 'get', paths: ['/orders'], methods: ['GET'], confidence: 'EXTRACTED' as const };
    expect(resolveSpringHttpEndpoints([endpoint], [
      file('src/main/resources/application.properties', 'spring.application.name=site'),
      file('src/main/resources/application-prod.properties', 'spring.application.name=bos'),
    ], 'funding')[0].service).toBeUndefined();
    expect(resolveSpringHttpEndpoints([endpoint], [file('src/main/resources/application.properties', 'spring.application.name=${SERVICE_NAME}')], 'funding')[0].service).toBeUndefined();
  });

  it('never shortens a dynamic class-level Spring mapping into a static endpoint', async () => {
    const result = await extractStructuralGraphAsFacts({ repoRoot: '/virtual', files: [file('Controller.java', '@RestController @RequestMapping(PREFIX) class Controller { @GetMapping("/orders") void get() {} }')] });
    expect(result.result.httpEndpoints).toEqual([]);
    expect(result.result.gaps.length).toBeGreaterThan(0);
  });

  it.each([1, 'team-wiki.graph-index.v1'])('rejects legacy graph version %s instead of relabeling it', (schemaVersion) => {
    expect(parseGraphIndex({ ...createGraphIndex(), schemaVersion })).toBeNull();
  });

  it('preserves every proof on a shared file edge and keeps distinct extractor sources', () => {
    const base = createGraphIndex([], [{ from: 'a', to: 'b', relation: 'REFERENCES', source: 'code-ast', evidence: [{ ref: 'a', lineStart: 1 }] }]);
    const merged = mergeGraphs(base, createGraphIndex([], [
      { from: 'a', to: 'b', relation: 'REFERENCES', source: 'code-ast', evidence: [{ ref: 'a', lineStart: 2 }] },
      { from: 'a', to: 'b', relation: 'REFERENCES', source: 'doc-semantic', evidence: [{ ref: 'doc' }] },
    ]));
    expect(merged.edges).toHaveLength(2);
    expect(merged.edges[0].evidence).toHaveLength(2);
  });

  it('removes a previously unique HTTP edge when aggregation discovers a competing endpoint', async () => {
    const wiki = await temp();
    const request = { origin: 'web', file: 'request.ts', line: 1, method: 'GET', path: '/orders', service: 'site' };
    const endpoint = { origin: 'api', file: 'Controller.java', line: 1, methods: ['GET'], path: '/orders', service: 'site' };
    const matches = matchHttpContracts([request], [endpoint]);
    const graph = createGraphIndex([node('web', 'request.ts'), node('api', 'Controller.java')], httpMatchesToGraphEdges(matches));
    graph.httpContracts = { requests: [request], endpoints: [endpoint], matches };
    await saveGraphIndex(path.join(wiki, 'evidence/code/web'), graph);
    const other = createGraphIndex([node('other', 'Controller.java')]);
    other.httpContracts = { requests: [], endpoints: [{ ...endpoint, origin: 'other' }] };
    await saveGraphIndex(path.join(wiki, 'evidence/code/other'), other);
    const aggregate = await buildAggregatedGraph(wiki);
    expect(aggregate?.edges.filter((edge) => edge.relation === 'CALLS_HTTP')).toEqual([]);
    expect(aggregate?.httpContracts?.matches?.[0].reason).toBe('Multiple matching endpoints');
  });

  it('filters contracts and scoped HTTP endpoints when a repository is withheld', async () => {
    const wiki = await temp();
    const request = { origin: 'web', file: 'request.ts', line: 1, method: 'GET', path: '/orders', service: 'site' };
    const endpoint = { origin: 'api', file: 'Controller.java', line: 1, methods: ['GET'], path: '/orders', service: 'site' };
    const matches = matchHttpContracts([request], [endpoint]);
    const graph = createGraphIndex([node('web', 'request.ts'), node('api', 'Controller.java')], httpMatchesToGraphEdges(matches));
    graph.httpContracts = { requests: [request], endpoints: [endpoint], matches };
    await saveGraphIndex(wiki, graph);
    const scoped = await scopeGlobalGraph(wiki, new Set(['api']));
    expect(scoped?.httpContracts?.endpoints).toEqual([]);
    expect(scoped?.httpContracts?.matches?.[0]).toMatchObject({ confidence: 'AMBIGUOUS', reason: 'Endpoint outside query scope' });
    expect(scoped?.edges).toEqual([]);
    expect(JSON.stringify(scoped)).not.toContain('code://api/');
  });

  it('lint flags missing nodes, contaminated HTTP evidence and stale coverage', async () => {
    const wiki = await temp();
    const graph = createGraphIndex([node('web', 'request.ts')], [{ from: 'code://web/request.ts', to: 'code://api/Controller.java', relation: 'CALLS_HTTP', source: 'code-http', evidence: [{ ref: 'wrong' }, { ref: 'other' }] }]);
    graph.httpContracts = { requests: [], endpoints: [], matches: [], coverage: httpContractCoverage(1, 0, [], [], []) };
    await saveGraphIndex(wiki, graph);
    const report = await lintTeamwiki({ wikiRoot: wiki });
    expect(report.issues.map((issue) => issue.category)).toEqual(expect.arrayContaining(['edge.missing_node', 'http-contract-mismatch', 'http-coverage-mismatch']));
  });

  it('rebuilds unchanged callers after a catalog-only change and removes deleted requests', async () => {
    const root = await temp();
    const output = await temp();
    await writeFile(path.join(root, 'url.ts'), 'export const URL = "https://site/old";');
    await writeFile(path.join(root, 'request.ts'), 'import { URL } from "./url"; fetch(URL);');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const options = { path: root, outputRoot: output, project: 'web', skipEnrich: true, maxFiles: 100 };
    await extractCodebase(options);
    await writeFile(path.join(root, 'url.ts'), 'export const URL = "https://site/new";');
    await extractCodebase({ ...options, incremental: true });
    const graphPath = path.join(output, 'teamwiki/.indices/graph-index.json');
    let graph = parseGraphIndex(JSON.parse(await readFile(graphPath, 'utf8')));
    expect(graph?.httpContracts?.requests.map((request) => request.path)).toEqual(['/new']);
    await rm(path.join(root, 'request.ts'));
    await extractCodebase({ ...options, incremental: true });
    graph = parseGraphIndex(JSON.parse(await readFile(graphPath, 'utf8')));
    expect(graph?.httpContracts?.requests).toEqual([]);
  });

  it('skips an unchanged imported v2 snapshot but rebuilds an unchanged v1 graph from source', async () => {
    const root = await temp();
    const wiki = await temp();
    await writeFile(path.join(root, 'request.ts'), 'fetch("https://site/orders");');
    const git = createGit(root);
    await git.init();
    await git.add('.');
    await git.raw(['-c', 'user.name=HTTP test', '-c', 'user.email=http-test@example.com', 'commit', '-m', 'fixture']);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const options = { sourceDir: root, wikiRoot: wiki, slug: 'web', skipEnrich: true, maxFiles: 100 };
    await importLocalCheckout(options);
    const graphPath = path.join(wiki, 'evidence/code/web/.indices/graph-index.json');
    const original = await readFile(graphPath, 'utf8');
    expect((await importLocalCheckout({ ...options, incremental: true })).updated, logs.mock.calls.map((call) => String(call[0])).join('\n')).toBe(false);
    expect(await readFile(graphPath, 'utf8')).toBe(original);
    await writeFile(graphPath, JSON.stringify({ ...JSON.parse(original), schemaVersion: 'team-wiki.graph-index.v1' }));
    expect((await importLocalCheckout({ ...options, incremental: true })).updated).toBe(true);
    const rebuilt = parseGraphIndex(JSON.parse(await readFile(graphPath, 'utf8')));
    expect(rebuilt?.httpContracts?.requests[0]).toMatchObject({ path: '/orders', service: 'site' });
  });

  it('iWiki leaves colliding repository labels unmapped', async () => {
    const wiki = await temp();
    await saveGraphIndex(wiki, createGraphIndex([{ ...node('a', 'Controller.java'), title: 'OrdersController' }, { ...node('b', 'Controller.java'), title: 'OrdersController' }]));
    expect(await reconcileIwikiWithCodebase([{ docid: '1', title: 'Orders', content: 'Use `OrdersController`.', url: 'https://example.test/1' }], wiki)).toEqual([]);
  });

  it('recall boosts only the repository whose source anchor matches a scoped node', async () => {
    const wiki = await temp();
    for (const origin of ['a', 'b']) {
      await mkdir(path.join(wiki, `evidence/code/${origin}`), { recursive: true });
      await writeFile(path.join(wiki, `evidence/code/${origin}/overview.md`), '---\ntitle: Overview\nsource: ["src/Controller.java"]\n---\norders detail');
    }
    await saveGraphIndex(wiki, createGraphIndex([{ ...node('a', 'src/Controller.java'), title: 'orders' }]));
    const results = await queryCodeKnowledge('orders', { wikiRoot: wiki, depth: 'lookup' });
    expect(results.find((result) => result.page.includes('/a/'))!.score).toBeGreaterThan(results.find((result) => result.page.includes('/b/'))!.score);
  });
});
