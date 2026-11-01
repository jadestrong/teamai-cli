import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';

// node scripts/verify-http-graph.mjs <output-root> <origin=source-root> ...
const [outputRoot, ...repositories] = process.argv.slice(2);
if (!outputRoot || !repositories.length) throw new Error('Supply output root and origin=source-root arguments');
const roots = new Map(repositories.map((entry) => {
  const separator = entry.indexOf('=');
  if (separator < 1) throw new Error('Expected origin=source-root');
  return [entry.slice(0, separator), entry.slice(separator + 1)];
}));
const errors = [];
let anchorsChecked = 0;
const sourceCache = new Map();
const routing = await fs.readFile(path.join(outputRoot, 'teamwiki/http-routing.yaml'), 'utf8').then(parse).catch((error) => {
  if (error.code === 'ENOENT') return undefined;
  throw error;
});
function check(condition, message) { if (!condition) errors.push(message); }
function identity(origin, file) { return `code://${origin}/${file}`; }
async function source(origin, file) {
  const key = identity(origin, file);
  if (sourceCache.has(key)) return sourceCache.get(key);
  const root = roots.get(origin);
  check(!!root && file && !file.startsWith('/') && path.posix.normalize(file) === file && !file.startsWith('../'), `Invalid source identity: ${key}`);
  let lines;
  if (root) {
    try { lines = (await fs.readFile(path.join(root, file), 'utf8')).split(/\r?\n/u); }
    catch { errors.push(`Missing source: ${key}`); }
  }
  sourceCache.set(key, lines);
  return lines;
}
async function anchor(ref, line) {
  if (!ref.startsWith('code://')) return;
  const match = /^code:\/\/([^/]+)\/(.+)$/u.exec(ref);
  check(!!match, `Malformed anchor: ${ref}`);
  if (!match) return;
  const lines = await source(match[1], match[2]);
  check(line === undefined || (Number.isInteger(line) && line > 0 && lines && line <= lines.length), `Invalid line anchor: ${ref}:${line}`);
  anchorsChecked++;
}
function normalize(value) {
  const normalized = `/${value.split(/[?#]/u)[0]}`.replace(/\/+/gu, '/').replace(/:([\w]+)/gu, '{$1}');
  return normalized.length > 1 ? normalized.replace(/\/$/u, '') : normalized;
}
function routedRequest(request, name) {
  if (name !== 'aggregate' || !routing || !request.path || !request.method || (request.unresolvedReason && !['Dynamic API host', 'Dynamic baseURL'].includes(request.unresolvedReason))) return request;
  const rules = routing.frontends.filter((f) => f.origin === request.origin).flatMap((f) => f.clients)
    .filter((c) => c.definition === (request.clientDefinition ?? request.file)).flatMap((c) => c.routes)
    .filter((r) => r.path !== null && r.rewrite !== null && r.backend !== null)
    .filter((r) => new RegExp(`^(?:${r.path})$`, 'u').test(request.path));
  if (!rules.length) return request;
  const max = Math.max(...rules.map((r) => r.priority ?? 0));
  const selected = rules.filter((r) => (r.priority ?? 0) === max);
  if (selected.length !== 1) return { ...request, unresolvedReason: 'Multiple matching proxy routes' };
  const rule = selected[0], captures = new RegExp(`^(?:${rule.path})$`, 'u').exec(request.path);
  const target = rule.rewrite.replace(/\$(\d+)/gu, (_, slot) => captures[Number(slot)] ?? '');
  if (!target.startsWith('/')) return { ...request, unresolvedReason: 'Invalid rewrite' };
  return { ...request, path: normalize(target), service: rule.backend.service, backendOrigin: rule.backend.origin, unresolvedReason: undefined };
}
function uniqueEndpoint(request, endpoints, name) {
  request = routedRequest(request, name);
  if (request.unresolvedReason || !request.service || !request.method || !request.path) return [];
  const shape = (value) => normalize(value).replace(/\{[\w$]+\}/gu, '{}');
  return endpoints.filter((endpoint) => (!request.backendOrigin || endpoint.origin === request.backendOrigin) && endpoint.service === request.service && shape(endpoint.path) === shape(request.path) && (!endpoint.methods || endpoint.methods.includes(request.method)));
}
function edgeKey(edge) { return JSON.stringify([edge.from, edge.to, edge.relation, edge.source]); }
async function inspectGraph(graph, name) {
  check(graph.schemaVersion === 'team-wiki.graph-index.v2', `${name}: legacy schema`);
  const nodeIds = new Set(graph.nodes.map((node) => node.slug));
  check(nodeIds.size === graph.nodes.length, `${name}: duplicate nodes`);
  for (const node of graph.nodes) {
    if (node.path || node.slug.startsWith('code://')) {
      check(node.slug === identity(node.origin, node.path), `${name}: inconsistent identity ${node.slug}`);
      await anchor(node.slug);
    }
  }
  const keys = new Set();
  const formalEdges = graph.edges.filter((edge) => edge.relation === 'CALLS_HTTP');
  for (const edge of graph.edges) {
    check(nodeIds.has(edge.from) && nodeIds.has(edge.to), `${name}: dangling edge ${edge.from} -> ${edge.to}`);
    check(!keys.has(edgeKey(edge)), `${name}: duplicate edge ${edgeKey(edge)}`);
    keys.add(edgeKey(edge));
    if (edge.source === 'code-ast' || edge.source === 'code-http') {
      check(edge.evidence?.length > 0, `${name}: missing extractor evidence`);
      for (const item of edge.evidence ?? []) await anchor(item.ref, item.lineStart);
    }
    const from = /^code:\/\/([^/]+)\//u.exec(edge.from)?.[1];
    const to = /^code:\/\/([^/]+)\//u.exec(edge.to)?.[1];
    if (from && to && from !== to) check(edge.relation === 'CALLS_HTTP' && edge.source === 'code-http', `${name}: unsupported cross-repository edge`);
  }
  const contracts = graph.httpContracts;
  check(!!contracts?.coverage && Array.isArray(contracts.matches), `${name}: missing observations, matches or coverage`);
  if (!contracts) return;
  for (const observation of [...contracts.requests, ...contracts.endpoints]) {
    check(nodeIds.has(identity(observation.origin, observation.file)), `${name}: observation references missing node`);
    await anchor(identity(observation.origin, observation.file), observation.line);
    for (const item of observation.evidence ?? []) await anchor(item.ref, item.lineStart);
  }
  const expectedEdges = new Set();
  let uniqueMatches = 0;
  for (const request of contracts.requests) {
    const endpoints = uniqueEndpoint(request, contracts.endpoints, name);
    const matches = contracts.matches.filter((match) => JSON.stringify(match.request) === JSON.stringify(request));
    check(matches.length === 1, `${name}: request has missing or duplicated match metadata`);
    if (endpoints.length === 1) {
      uniqueMatches++;
      const endpoint = endpoints[0];
      const key = edgeKey({ from: identity(request.origin, request.file), to: identity(endpoint.origin, endpoint.file), relation: 'CALLS_HTTP', source: 'code-http' });
      expectedEdges.add(key);
      check(matches[0]?.confidence === 'EXTRACTED' && JSON.stringify(matches[0].endpoint) === JSON.stringify(endpoint), `${name}: incorrect unique match`);
      const edge = formalEdges.find((candidate) => edgeKey(candidate) === key);
      check(!!edge, `${name}: unique match lacks a formal edge`);
      for (const record of [request, endpoint]) check(edge?.evidence?.some((item) => item.ref === identity(record.origin, record.file) && item.lineStart === record.line), `${name}: HTTP edge lost a call/definition anchor`);
      for (const item of [...request.evidence ?? [], ...endpoint.evidence ?? []]) check(edge?.evidence?.some((proof) => JSON.stringify(proof) === JSON.stringify(item)), `${name}: HTTP edge lost configuration evidence`);
      const resolved = routedRequest(request, name);
      if (resolved.backendOrigin) {
        check(matches[0]?.resolution?.path === resolved.path && matches[0]?.resolution?.backendOrigin === resolved.backendOrigin && matches[0]?.resolution?.service === resolved.service, `${name}: wrong routing resolution`);
        check(edge?.evidence?.some((proof) => proof.ref === 'http-routing.yaml' && proof.type === 'config'), `${name}: HTTP edge lost proxy evidence`);
      }
    } else check(matches[0]?.confidence === 'AMBIGUOUS' && !matches[0]?.endpoint, `${name}: unresolved request became formal`);
  }
  for (const edge of formalEdges) check(expectedEdges.has(edgeKey(edge)), `${name}: unexpected formal HTTP edge`);
  const coverage = contracts.coverage;
  if (coverage) {
    check(coverage.filesScanned === coverage.filesParsed + coverage.filesFailed + (coverage.filesUnsupported ?? 0), `${name}: file coverage does not add up`);
    check(coverage.requests === contracts.requests.length && coverage.endpoints === contracts.endpoints.length && coverage.uniqueMatches === uniqueMatches, `${name}: contract coverage differs from observations`);
    check(coverage.requests === coverage.uniqueMatches + coverage.candidates + coverage.unresolved, `${name}: request coverage does not add up`);
  }
  return { name, nodes: graph.nodes.length, edges: graph.edges.length, formalHttpEdges: formalEdges.length, coverage,
    staticRequestPaths: contracts.requests.filter((request) => request.path).length,
    services: [...new Set(contracts.endpoints.map((endpoint) => endpoint.service ?? '(unresolved)'))].sort(),
    reasons: Object.fromEntries([...new Set(contracts.matches.map((match) => match.reason).filter(Boolean))].map((reason) => [reason, contracts.matches.filter((match) => match.reason === reason).length])),
  };
}
const summaries = [];
const graph = JSON.parse(await fs.readFile(path.join(outputRoot, 'teamwiki/.indices/graph-index.json'), 'utf8'));
for (const origin of roots.keys()) {
  const repoGraph = JSON.parse(await fs.readFile(path.join(outputRoot, `teamwiki/evidence/code/${origin}/.indices/graph-index.json`), 'utf8'));
  summaries.push(await inspectGraph(repoGraph, origin));
}
summaries.push(await inspectGraph(graph, 'aggregate'));
const repositoryState = Object.fromEntries([...roots].map(([origin, root]) => [origin, {
  root, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  status: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim(),
}]));
const sampleRequests = graph.httpContracts.requests.filter((request) => request.file === 'app/modules/BankCards/request.ts' || request.file === 'app/modules/Withdraw/BSWithdraw/request.ts');
const sampleEndpoints = graph.httpContracts.endpoints.filter((endpoint) => endpoint.file.endsWith('/BankSwiftController.java'));
check(sampleRequests.some((request) => request.method === 'GET' && request.path === '/funding/bank-swift'), 'AMS BankSwift representative request missing');
const expectedBankSwiftPaths = ['/bank-swift/dda', '/bank-swift', '/bank-swift/check-result', '/bank-swift/query/single', '/bank-swift/{id}/guide', '/bank-swift/pay-to'];
check(sampleEndpoints.length === expectedBankSwiftPaths.length && expectedBankSwiftPaths.every((expectedPath) => sampleEndpoints.some((endpoint) => endpoint.methods?.includes('GET') && endpoint.path === expectedPath && endpoint.service === 'funding-site')), 'Funding BankSwift mappings differ from the six source declarations');
for (const endpoint of sampleEndpoints) {
  const lines = await source(endpoint.origin, endpoint.file);
  check(lines?.[endpoint.line - 1]?.includes('@GetMapping'), `BankSwift definition anchor does not point to its mapping: ${endpoint.line}`);
}
const report = { generatedAt: new Date().toISOString(), passed: errors.length === 0, errors, anchorsChecked, sourceFilesChecked: sourceCache.size, summaries, repositoryState, sampleRequests, sampleEndpoints,
  limitations: ['This verifies static CLI extraction from the real repositories. Endpoint counts describe source declarations, including conditionally registered controllers, rather than runtime availability.', routing ? 'Formal HTTP edges use explicitly configured client-scoped proxy routes. Unconfigured or unresolved URLs and methods remain observations; no deployed API requests were executed.' : 'Dynamic gateway hosts and proxy paths without explicit routing configuration remain unresolved.'],
};
await fs.writeFile(path.join(outputRoot, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
const rows = summaries.map((summary) => `| ${summary.name} | ${summary.coverage.filesScanned} | ${summary.nodes} | ${summary.edges} | ${summary.coverage.requests} | ${summary.coverage.endpoints} | ${summary.formalHttpEdges} |`).join('\n');
const markdown = `# AMS / funding extraction verification\n\nResult: ${report.passed ? 'PASS' : 'FAIL'} (${errors.length} errors). Checked ${sourceCache.size} source files and ${anchorsChecked} anchors.\n\n| Graph | Scanned files | Nodes | Edges | Requests | Endpoints | Formal HTTP edges |\n|---|---:|---:|---:|---:|---:|---:|\n${rows}\n\nValidated scoped file identities, repository isolation, source lines, dangling edges, unique method/path/service matches, request/endpoint/configuration evidence, persisted match metadata and coverage totals.\n\n${report.limitations.join('\n')}\n\nRepresentative source observations and repository revisions are in [verification.json](verification.json). All per-repository graphs are under [teamwiki/evidence/code](teamwiki/evidence/code); the combined graph is [teamwiki/.indices/graph-index.json](teamwiki/.indices/graph-index.json).\n${errors.length ? `\n## Errors\n\n${errors.map((error) => `- ${error}`).join('\n')}\n` : ''}`;
await fs.writeFile(path.join(outputRoot, 'REPORT.md'), markdown);
console.log(JSON.stringify({ passed: report.passed, errors: errors.length, anchorsChecked, summaries }, null, 2));
if (!report.passed) process.exitCode = 1;
