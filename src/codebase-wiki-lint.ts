import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import chalk from 'chalk';

import { pathExists } from './utils/fs.js';
import { GRAPH_INDEX_SCHEMA_VERSION, parseGraphIndex, type GraphIndex } from './wiki-engine/adapters/index.js';
import { validateGraph, graphEdgeKey } from './wiki-engine/core/graph-index.schema.js';
import { codeFileId } from './wiki-engine/code-knowledge/code-identity.js';
import { httpMatchesToGraphEdges, httpContractCoverage } from './wiki-engine/code-knowledge/http-contract.js';
import { loadHttpRouting, matchRoutedHttpContracts } from './http-routing.js';

export type WikiLintSeverity = 'high' | 'medium' | 'low' | 'info';

export interface WikiLintIssue {
  severity: WikiLintSeverity;
  category: string;
  location: string;
  message: string;
}

export interface WikiLintReport {
  issues: WikiLintIssue[];
  summary: {
    total: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  graphHealth: {
    nodeCount: number;
    edgeCount: number;
    orphanNodes: number;
    connectivity: number;
  };
}

export async function lintTeamwiki(opts: {
  cwd?: string;
  wikiRoot?: string;
  severity?: WikiLintSeverity;
}): Promise<WikiLintReport> {
  const wikiRoot = opts.wikiRoot ?? path.join(opts.cwd ?? process.cwd(), 'teamwiki');
  const issues: WikiLintIssue[] = [];
  const minSeverity = opts.severity ?? 'info';
  const severityOrder: WikiLintSeverity[] = ['info', 'low', 'medium', 'high'];
  const minIdx = severityOrder.indexOf(minSeverity);

  function addIssue(issue: WikiLintIssue): void {
    if (severityOrder.indexOf(issue.severity) >= minIdx) {
      issues.push(issue);
    }
  }

  // Check graph-index.json exists
  const graphPath = path.join(wikiRoot, '.indices', 'graph-index.json');
  let graph: GraphIndex | null = null;

  if (!await pathExists(graphPath)) {
    addIssue({
      severity: 'high',
      category: 'graph-missing',
      location: 'teamwiki/.indices/graph-index.json',
      message: 'graph-index.json does not exist; build the knowledge graph',
    });
  } else {
    try {
      const raw = await readFile(graphPath, 'utf-8');
      const parsed = JSON.parse(raw);
      graph = parseGraphIndex(parsed);
      if (!graph || parsed.schemaVersion !== GRAPH_INDEX_SCHEMA_VERSION) {
        addIssue({
          severity: 'high',
          category: 'graph-rebuild-required',
          location: 'teamwiki/.indices/graph-index.json',
          message: `graph-index.json is not ${GRAPH_INDEX_SCHEMA_VERSION}; rebuild it from source`,
        });
      }
    } catch {
      addIssue({
        severity: 'high',
        category: 'graph-corrupt',
        location: graphPath,
        message: 'Cannot parse graph-index.json',
      });
    }
  }

  // Check evidence directory
  const evidenceDir = path.join(wikiRoot, 'evidence', 'code');
  if (!await pathExists(evidenceDir)) {
    addIssue({
      severity: 'high',
      category: 'evidence-missing',
      location: 'teamwiki/evidence/code/',
      message: 'Code evidence directory does not exist',
    });
  } else {
    const projects = await readdir(evidenceDir);
    if (projects.length === 0) {
      addIssue({
        severity: 'medium',
        category: 'evidence-empty',
        location: 'teamwiki/evidence/code/',
        message: 'Code evidence directory is empty',
      });
    }

    for (const project of projects) {
      const projectDir = path.join(evidenceDir, project);
      const pStat = await stat(projectDir).catch(() => null);
      if (!pStat?.isDirectory()) {
        if (!pStat) {
          addIssue({ severity: 'low', category: 'stat-failed', location: `evidence/code/${project}`, message: 'Cannot read directory status' });
        }
        continue;
      }

      const files = await readdir(projectDir);
      if (!files.includes('index.md')) {
        addIssue({
          severity: 'low',
          category: 'missing-index',
          location: `evidence/code/${project}/`,
          message: 'Missing index.md overview',
        });
      }
    }
  }

  // Check navigation files (router.md, index.md, hot.md)
  for (const navFile of ['router.md', 'index.md', 'hot.md']) {
    if (!await pathExists(path.join(wikiRoot, navFile))) {
      addIssue({
        severity: 'low',
        category: 'nav-missing',
        location: `teamwiki/${navFile}`,
        message: `Missing navigation file: ${navFile}`,
      });
    }
  }

  // Check source-manifest.json
  const manifestPath = path.join(wikiRoot, 'source-manifest.json');
  if (!await pathExists(manifestPath)) {
    addIssue({
      severity: 'low',
      category: 'manifest-missing',
      location: 'teamwiki/source-manifest.json',
      message: 'Missing source-manifest.json; incremental updates are unavailable',
    });
  } else {
    try {
      const raw = await readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw);
      if (manifest.lastScan) {
        const daysSince = (Date.now() - new Date(manifest.lastScan).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince > 60) {
          addIssue({
            severity: 'medium',
            category: 'stale-manifest',
            location: 'teamwiki/source-manifest.json',
            message: `Last scan was ${Math.floor(daysSince)} days ago; refresh it with \`teamai import --incremental\``,
          });
        }
      }
    } catch {
      addIssue({
        severity: 'low',
        category: 'manifest-corrupt',
        location: manifestPath,
        message: 'Cannot parse source-manifest.json',
      });
    }
  }

  // Graph health metrics
  let graphHealth = { nodeCount: 0, edgeCount: 0, orphanNodes: 0, connectivity: 0 };
  if (graph) {
    const location = 'teamwiki/.indices/graph-index.json';
    for (const issue of validateGraph(graph).issues) {
      if (issue.code === 'edge.self_loop') continue; // Same-file IMPLEMENTS is valid.
      addIssue({ severity: 'high', category: issue.code, location, message: issue.message });
    }
    const inconsistentCodeNodes = graph.nodes.filter((node) => {
      if (!node.slug.startsWith('code://')) return false;
      try { return !node.origin || !node.path || codeFileId(node.origin, node.path) !== node.slug; } catch { return true; }
    });
    if (inconsistentCodeNodes.length) addIssue({ severity: 'high', category: 'code-identity-mismatch', location, message: `${inconsistentCodeNodes.length} code node(s) have inconsistent origin, path or identity` });
    const unscopedCodeNodes = graph.nodes.filter((node) => node.path && !node.slug.startsWith('code://'));
    if (unscopedCodeNodes.length > 0) {
      addIssue({
        severity: 'high',
        category: 'unscoped-code-identity',
        location: 'teamwiki/.indices/graph-index.json',
        message: `${unscopedCodeNodes.length} code file node(s) lack code:// scoped identities`,
      });
    }
    const invalidHttpEdges = graph.edges.filter((edge) => edge.relation === 'CALLS_HTTP' &&
      (edge.source !== 'code-http' || (edge.evidence?.length ?? 0) < 2));
    if (invalidHttpEdges.length > 0) {
      addIssue({
        severity: 'high',
        category: 'http-evidence-missing',
        location: 'teamwiki/.indices/graph-index.json',
        message: `${invalidHttpEdges.length} CALLS_HTTP edge(s) lack extractor provenance or both endpoint evidences`,
      });
    }
    const contracts = graph.httpContracts;
    let routing: Awaited<ReturnType<typeof loadHttpRouting>>;
    try { routing = await loadHttpRouting(wikiRoot); }
    catch (error) { addIssue({ severity: 'high', category: 'http-routing-invalid', location: 'teamwiki/http-routing.yaml', message: String(error) }); }
    const matches = contracts ? matchRoutedHttpContracts(contracts.requests, contracts.endpoints, routing) : [];
    const formal = httpMatchesToGraphEdges(matches);
    const expected = new Set(formal.map(graphEdgeKey));
    const actual = new Set(graph.edges.filter((edge) => edge.relation === 'CALLS_HTTP').map(graphEdgeKey));
    if ([...actual].some((key) => !expected.has(key)) || [...expected].some((key) => !actual.has(key))) {
      addIssue({ severity: 'high', category: 'http-contract-mismatch', location, message: 'CALLS_HTTP edges do not match the unique method/path/service contracts' });
    }
    if (contracts) {
      if (contracts.routingHash !== routing?.hash) addIssue({ severity: 'high', category: 'http-routing-stale', location, message: 'HTTP routing configuration changed; run `teamai codebase --reconcile` or an incremental import' });
      const nodeIds = new Set(graph.nodes.map((node) => node.slug));
      const observations = [...contracts.requests, ...contracts.endpoints];
      const missing = observations.filter((record) => {
        try { return !nodeIds.has(codeFileId(record.origin, record.file)); } catch { return true; }
      });
      if (missing.length) addIssue({ severity: 'high', category: 'http-node-missing', location, message: `${missing.length} HTTP observation(s) reference missing code nodes` });
      if (JSON.stringify(contracts.matches) !== JSON.stringify(matches)) addIssue({ severity: 'high', category: 'http-matches-stale', location, message: 'Persisted HTTP matches are missing or stale' });
      const coverage = contracts.coverage;
      if (coverage) {
        const recomputed = httpContractCoverage(coverage.filesScanned, coverage.filesParsed, contracts.requests, contracts.endpoints, matches, coverage.filesFailed, coverage.filesUnsupported);
        if (JSON.stringify(coverage) !== JSON.stringify(recomputed) || coverage.filesScanned !== coverage.filesParsed + coverage.filesFailed + (coverage.filesUnsupported ?? 0)) {
          addIssue({ severity: 'high', category: 'http-coverage-mismatch', location, message: 'HTTP coverage does not reconcile with observations and file totals' });
        }
      }
      for (const edge of graph.edges.filter((candidate) => candidate.relation === 'CALLS_HTTP')) {
        const proofs = formal.filter((proof) => graphEdgeKey(proof) === graphEdgeKey(edge));
        if (!proofs.every((proof) => proof.evidence?.every((item) => edge.evidence?.some((recorded) => JSON.stringify(recorded) === JSON.stringify(item))))) {
          addIssue({ severity: 'high', category: 'http-evidence-mismatch', location, message: `CALLS_HTTP evidence is incomplete: ${edge.from} -> ${edge.to}` });
        }
      }
    }
    const connectedNodes = new Set<string>();
    for (const edge of graph.edges) {
      connectedNodes.add(edge.from);
      connectedNodes.add(edge.to);
    }
    const orphans = graph.nodes.filter(n => !connectedNodes.has(n.slug));
    const connectivity = graph.nodes.length > 0
      ? (graph.nodes.length - orphans.length) / graph.nodes.length
      : 0;

    graphHealth = {
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      orphanNodes: orphans.length,
      connectivity: Math.round(connectivity * 100) / 100,
    };

    if (connectivity < 0.3) {
      addIssue({
        severity: 'medium',
        category: 'low-connectivity',
        location: 'teamwiki/.indices/graph-index.json',
        message: `Graph connectivity is ${(connectivity * 100).toFixed(0)}% (${orphans.length} orphan nodes)`,
      });
    }

    if (graph.edges.length === 0 && graph.nodes.length > 10) {
      addIssue({
        severity: 'high',
        category: 'no-edges',
        location: 'teamwiki/.indices/graph-index.json',
        message: `Graph has ${graph.nodes.length} nodes but no edges; graph construction may have failed`,
      });
    }
  }

  const summary = {
    total: issues.length,
    high: issues.filter(i => i.severity === 'high').length,
    medium: issues.filter(i => i.severity === 'medium').length,
    low: issues.filter(i => i.severity === 'low').length,
    info: issues.filter(i => i.severity === 'info').length,
  };

  return { issues, summary, graphHealth };
}

export function formatWikiLintReport(report: WikiLintReport): string {
  const lines: string[] = [];

  lines.push(chalk.bold('=== teamwiki/ knowledge graph health ==='));
  lines.push('');
  lines.push(`Graph: ${report.graphHealth.nodeCount} nodes, ${report.graphHealth.edgeCount} edges, connectivity ${(report.graphHealth.connectivity * 100).toFixed(0)}%`);
  if (report.graphHealth.orphanNodes > 0) {
    lines.push(chalk.dim(`  (${report.graphHealth.orphanNodes} orphan nodes)`));
  }
  lines.push('');

  if (report.issues.length === 0) {
    lines.push(chalk.green('✓ No issues'));
    return lines.join('\n');
  }

  const byCategory = new Map<string, WikiLintIssue[]>();
  for (const issue of report.issues) {
    const existing = byCategory.get(issue.category) ?? [];
    existing.push(issue);
    byCategory.set(issue.category, existing);
  }

  for (const [category, categoryIssues] of byCategory) {
    lines.push(chalk.bold(`[${category}] (${categoryIssues.length})`));
    for (const issue of categoryIssues) {
      const sevColor = issue.severity === 'high' ? chalk.red
        : issue.severity === 'medium' ? chalk.yellow : chalk.dim;
      lines.push(`  ${sevColor(`[${issue.severity}]`)} ${issue.location}: ${issue.message}`);
    }
    lines.push('');
  }

  lines.push(`Total: ${report.summary.high} high, ${report.summary.medium} medium, ${report.summary.low} low, ${report.summary.info} info`);
  return lines.join('\n');
}
