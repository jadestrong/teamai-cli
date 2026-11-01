import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { CONFIDENCE_SCORE_DEFAULTS, WIKI_CATEGORIES, type WikiCategory, type WikiConfidence, type WikiEvidence } from "./wiki-protocol.js";

/**
 * Graph Index Schema — team-wiki.graph-index.v2
 *
 * Formal schema for knowledge graph indices that capture
 * relationships between wiki pages and code entities.
 */

export const GRAPH_INDEX_SCHEMA_VERSION = "team-wiki.graph-index.v2" as const;

export type RelationType =
  | "DEPENDS_ON"
  | "IMPLEMENTS"
  | "MAPS_TO"
  | "CONTAINS"
  | "REFERENCES"
  | "CONFLICTS_WITH"
  | "SUPERSEDES"
  | "CALLS_HTTP";

export const RELATION_TYPES: RelationType[] = [
  "DEPENDS_ON",
  "IMPLEMENTS",
  "MAPS_TO",
  "CONTAINS",
  "REFERENCES",
  "CONFLICTS_WITH",
  "SUPERSEDES",
  "CALLS_HTTP",
];

export interface GraphNode {
  slug: string;
  /** Repository-relative path for a scoped code-file node. */
  path?: string;
  type: WikiCategory;
  confidence: WikiConfidence;
  title: string;
  domain?: string;
  source?: GraphEdgeSource;
  /**
   * The codebase slug (`evidence/code/<origin>/`) this node's own per-repo
   * graph file contributed it from, stamped by the aggregation that merges
   * per-repo graphs into the global one (#912). Absent on a cross-repo edge
   * node reference and on anything aggregated before this field existed.
   * Authoritative once present: it travels with the data itself, so it
   * stays correct even if that per-repo file is later deleted, emptied, or
   * rewritten to describe something different, which reading the per-repo
   * file back out at query time cannot promise.
   */
  origin?: string;
}

/** Provenance of a graph edge (compile / reconcile pipeline). */
export type GraphEdgeSource =
  | "code-ast"
  | "code-http"
  | "code-heuristic"
  | "doc-structure"
  | "doc-entity"
  | "doc-triples"
  | "bridge-reconcile"
  | "doc-semantic"
  | "manual-mapping";

const LEGACY_GRAPH_EDGE_SOURCE = "code-heuristic" as const;

export const GRAPH_EDGE_SOURCES: readonly GraphEdgeSource[] = [
  "code-ast",
  "code-http",
  LEGACY_GRAPH_EDGE_SOURCE,
  "doc-structure",
  "doc-entity",
  "doc-triples",
  "bridge-reconcile",
  "doc-semantic",
  "manual-mapping",
];

const WIKI_CONFIDENCES = Object.keys(CONFIDENCE_SCORE_DEFAULTS) as WikiConfidence[];
const WIKI_EVIDENCE_TYPES = ["definition", "implementation", "usage", "schema", "config"] as const;
const LEGACY_WIKI_CONFIDENCES: Record<string, WikiConfidence> = {
  high: "EXTRACTED",
  medium: "INFERRED",
  low: "AMBIGUOUS",
};
/** A relation name `loadGraphIndex` normalizes to a current `RelationType` on load. */
export const LEGACY_RELATIONS: Record<string, RelationType> = {
  imports: "DEPENDS_ON",
};
const LEGACY_WIKI_CATEGORIES: Record<string, WikiCategory> = {
  module: "component",
};

export interface GraphEdge {
  from: string;
  to: string;
  relation: RelationType;
  evidence?: WikiEvidence[];
  weight?: number;
  /** Fine-grained semantic predicate (e.g. USES_TABLE). */
  predicate?: string;
  source?: GraphEdgeSource;
  /** Origin of the extractor that emitted the edge. */
  origin?: string;
  /** @deprecated v2 extractors never emit synthetic cross-origin provenance. */
  crossOriginPairs?: string[][];
}

/** Edge source is part of its identity: distinct extractors must not overwrite evidence. */
export const graphEdgeKey = (edge: GraphEdge): string => JSON.stringify([edge.from, edge.to, edge.relation, edge.source ?? "unknown"]);

/** Wiki page slug: relative path without `.md`. */
export function toPageSlug(relativePath: string): string {
  return relativePath.replace(/\.md$/u, "").replace(/\\/g, "/");
}

export interface GraphIndex {
  schemaVersion: typeof GRAPH_INDEX_SCHEMA_VERSION;
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Persisted observations. They are candidates until a unique match becomes CALLS_HTTP. */
  httpContracts?: GraphHttpContracts;
}

export interface GraphHttpContracts {
  requests: HttpRequestContractRecord[];
  endpoints: HttpEndpointContractRecord[];
  coverage?: HttpContractCoverage;
  matches?: HttpContractMatchRecord[];
  coverageByOrigin?: Record<string, HttpContractCoverage>;
  routingHash?: string;
}

export interface HttpContractMatchRecord {
  request: HttpRequestContractRecord;
  endpoint?: HttpEndpointContractRecord;
  confidence: "EXTRACTED" | "AMBIGUOUS";
  reason?: string;
  resolution?: { path: string; service: string; backendOrigin: string; evidence: WikiEvidence[] };
}

export interface HttpRequestContractRecord {
  origin: string;
  file: string;
  line: number;
  method: string;
  path: string;
  clientDefinition?: string;
  service?: string;
  unresolvedReason?: string;
  evidence?: WikiEvidence[];
}

export interface HttpEndpointContractRecord {
  origin: string;
  file: string;
  line: number;
  methods?: string[];
  path: string;
  service?: string;
  evidence?: WikiEvidence[];
}

export interface HttpContractCoverage {
  filesScanned: number;
  filesParsed: number;
  filesFailed: number;
  filesUnsupported?: number;
  requests: number;
  endpoints: number;
  uniqueMatches: number;
  candidates: number;
  unresolved: number;
}

const WikiEvidenceSchema = z.object({
  ref: z.string(),
  lineStart: z.number().optional(),
  lineEnd: z.number().optional(),
  commit: z.string().optional(),
  type: z.enum(WIKI_EVIDENCE_TYPES).optional(),
  note: z.string().optional(),
}).passthrough();

const WikiConfidenceSchema = z.string().transform((value, context): WikiConfidence => {
  if (WIKI_CONFIDENCES.includes(value as WikiConfidence)) return value as WikiConfidence;
  const normalized = Object.hasOwn(LEGACY_WIKI_CONFIDENCES, value)
    ? LEGACY_WIKI_CONFIDENCES[value]
    : undefined;
  if (normalized) return normalized;
  context.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid wiki confidence: ${value}` });
  return z.NEVER;
});

// Unscoped v1 graphs cannot be reconstructed after collisions. Re-extract
// the source repositories; never relabel old records as a v2 graph.
const GraphIndexVersionSchema = z.literal(GRAPH_INDEX_SCHEMA_VERSION);

const GraphNodeSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const node = value as Record<string, unknown>;
  const rawType = node.type ?? node.kind;
  return {
    ...node,
    slug: node.slug ?? node.id,
    type: typeof rawType === "string" && Object.hasOwn(LEGACY_WIKI_CATEGORIES, rawType)
      ? LEGACY_WIKI_CATEGORIES[rawType]
      : rawType,
    title: node.title ?? node.label,
  };
}, z.object({
  slug: z.string(),
  type: z.custom<WikiCategory>((value) => WIKI_CATEGORIES.includes(value as WikiCategory)),
  confidence: WikiConfidenceSchema,
  title: z.string(),
  path: z.string().optional(),
  domain: z.string().optional(),
  source: z.custom<GraphEdgeSource>((value) => GRAPH_EDGE_SOURCES.includes(value as GraphEdgeSource)).optional(),
  origin: z.string().optional(),
}).passthrough());

const GraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  relation: z.string(),
  evidence: z.array(WikiEvidenceSchema).optional(),
  weight: z.number().optional(),
  predicate: z.string().optional(),
  source: z.custom<GraphEdgeSource>((value) => GRAPH_EDGE_SOURCES.includes(value as GraphEdgeSource)).optional(),
  origin: z.string().optional(),
}).passthrough().transform((edge, context): GraphEdge => {
  const legacyRelation = Object.hasOwn(LEGACY_RELATIONS, edge.relation)
    ? LEGACY_RELATIONS[edge.relation]
    : undefined;
  const relation = RELATION_TYPES.includes(edge.relation as RelationType)
    ? edge.relation as RelationType
    : legacyRelation;
  if (!relation) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid graph relation: ${edge.relation}` });
    return z.NEVER;
  }
  return {
    ...edge,
    relation,
    source: edge.source ?? (legacyRelation ? LEGACY_GRAPH_EDGE_SOURCE : undefined),
  };
});

const GraphIndexSchema = z.object({
  schemaVersion: GraphIndexVersionSchema,
  generatedAt: z.string(),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  httpContracts: z.object({
    requests: z.array(z.object({ origin: z.string(), file: z.string(), line: z.number(), method: z.string(), path: z.string(), clientDefinition: z.string().optional(), service: z.string().optional(), unresolvedReason: z.string().optional(), evidence: z.array(WikiEvidenceSchema).optional() })),
    endpoints: z.array(z.object({ origin: z.string(), file: z.string(), line: z.number(), methods: z.array(z.string()).optional(), path: z.string(), service: z.string().optional(), evidence: z.array(WikiEvidenceSchema).optional() })),
    coverage: z.object({ filesScanned: z.number(), filesParsed: z.number(), filesFailed: z.number(), filesUnsupported: z.number().optional(), requests: z.number(), endpoints: z.number(), uniqueMatches: z.number(), candidates: z.number(), unresolved: z.number() }).optional(),
    matches: z.array(z.object({
      request: z.object({ origin: z.string(), file: z.string(), line: z.number(), method: z.string(), path: z.string(), clientDefinition: z.string().optional(), service: z.string().optional(), unresolvedReason: z.string().optional(), evidence: z.array(WikiEvidenceSchema).optional() }),
      endpoint: z.object({ origin: z.string(), file: z.string(), line: z.number(), methods: z.array(z.string()).optional(), path: z.string(), service: z.string().optional(), evidence: z.array(WikiEvidenceSchema).optional() }).optional(),
      confidence: z.enum(["EXTRACTED", "AMBIGUOUS"]), reason: z.string().optional(),
      resolution: z.object({ path: z.string(), service: z.string(), backendOrigin: z.string(), evidence: z.array(WikiEvidenceSchema) }).optional(),
    })).optional(),
    routingHash: z.string().optional(),
    coverageByOrigin: z.record(z.string(), z.object({ filesScanned: z.number(), filesParsed: z.number(), filesFailed: z.number(), filesUnsupported: z.number().optional(), requests: z.number(), endpoints: z.number(), uniqueMatches: z.number(), candidates: z.number(), unresolved: z.number() })).optional(),
  }).optional(),
}).passthrough();

/** Validates v2 graph records; legacy v1 requires re-extraction from source. */
export function parseGraphIndex(value: unknown): GraphIndex | null {
  const result = GraphIndexSchema.safeParse(value);
  return result.success ? result.data as GraphIndex : null;
}

/**
 * Create an empty GraphIndex with the current timestamp.
 */
export function createGraphIndex(nodes: GraphNode[] = [], edges: GraphEdge[] = []): GraphIndex {
  return {
    schemaVersion: GRAPH_INDEX_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
  };
}

/**
 * Add a node to the graph index. If a node with the same slug already exists,
 * it is replaced with the new node.
 */
export function addNode(graph: GraphIndex, node: GraphNode): GraphIndex {
  const filtered = graph.nodes.filter((n) => n.slug !== node.slug);
  return { ...graph, nodes: [...filtered, node] };
}

/**
 * Add an edge to the graph index. Duplicate edges (same from, to, relation) are not added.
 */
export function addEdge(graph: GraphIndex, edge: GraphEdge): GraphIndex {
  const exists = graph.edges.some(
    (e) => graphEdgeKey(e) === graphEdgeKey(edge)
  );
  if (exists) {
    return graph;
  }
  return { ...graph, edges: [...graph.edges, edge] };
}

/**
 * Add an edge using confidence level as weight when no explicit weight is provided.
 * Falls back to CONFIDENCE_SCORE_DEFAULTS for the given confidence level.
 */
export function addEdgeWithConfidence(
  graph: GraphIndex,
  edge: Omit<GraphEdge, "weight"> & { weight?: number },
  confidence: WikiConfidence
): GraphIndex {
  const weight = edge.weight ?? CONFIDENCE_SCORE_DEFAULTS[confidence];
  return addEdge(graph, { ...edge, weight });
}

/**
 * Find all neighbor slugs of a given node (connected via any edge direction).
 */
export function findNeighbors(graph: GraphIndex, slug: string): string[] {
  const neighbors = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.from === slug) {
      neighbors.add(edge.to);
    }
    if (edge.to === slug) {
      neighbors.add(edge.from);
    }
  }
  return [...neighbors].sort();
}

/**
 * Find all neighbor slugs reachable within N hops.
 * Optionally filter by specific relation types.
 * Uses BFS to expand outward from the starting node.
 */
export function findNeighborsNHop(
  graph: GraphIndex,
  slug: string,
  hops: number,
  filterRelations?: RelationType[]
): string[] {
  const visited = new Set<string>([slug]);
  let frontier = new Set<string>([slug]);

  for (let hop = 0; hop < hops; hop++) {
    const nextFrontier = new Set<string>();
    for (const current of frontier) {
      for (const edge of graph.edges) {
        if (filterRelations && !filterRelations.includes(edge.relation)) {
          continue;
        }
        let neighbor: string | null = null;
        if (edge.from === current && !visited.has(edge.to)) {
          neighbor = edge.to;
        } else if (edge.to === current && !visited.has(edge.from)) {
          neighbor = edge.from;
        }
        if (neighbor) {
          visited.add(neighbor);
          nextFrontier.add(neighbor);
        }
      }
    }
    frontier = nextFrontier;
    if (frontier.size === 0) break;
  }

  visited.delete(slug); // Remove starting node from results
  return [...visited].sort();
}

export interface GraphValidationIssue {
  code: "node.duplicate" | "edge.duplicate" | "edge.missing_node" | "edge.self_loop" | "edge.invalid_weight";
  message: string;
}

export interface GraphValidationResult {
  valid: boolean;
  issues: GraphValidationIssue[];
}

/**
 * Validate a graph index for structural correctness:
 * - No duplicate node slugs
 * - No duplicate edge identities
 * - All edge endpoints reference existing nodes
 * - No self-loop edges
 * - Edge weights (if provided) are between 0 and 1
 */
export function validateGraph(graph: GraphIndex): GraphValidationResult {
  const issues: GraphValidationIssue[] = [];
  const slugs = new Set<string>();
  const edgeKeys = new Set<string>();

  for (const node of graph.nodes) {
    if (slugs.has(node.slug)) {
      issues.push({
        code: "node.duplicate",
        message: `Duplicate node slug: ${node.slug}`,
      });
    }
    slugs.add(node.slug);
  }

  for (const edge of graph.edges) {
    const edgeKey = graphEdgeKey(edge);
    if (edgeKeys.has(edgeKey)) {
      issues.push({
        code: "edge.duplicate",
        message: `Duplicate edge: ${edge.from} -> ${edge.to} (${edge.relation})`,
      });
    }
    edgeKeys.add(edgeKey);
    if (!slugs.has(edge.from)) {
      issues.push({
        code: "edge.missing_node",
        message: `Edge references non-existent source node: ${edge.from}`,
      });
    }
    if (!slugs.has(edge.to)) {
      issues.push({
        code: "edge.missing_node",
        message: `Edge references non-existent target node: ${edge.to}`,
      });
    }
    if (edge.from === edge.to) {
      issues.push({
        code: "edge.self_loop",
        message: `Self-loop edge on node: ${edge.from}`,
      });
    }
    if (edge.weight !== undefined && (edge.weight < 0 || edge.weight > 1)) {
      issues.push({
        code: "edge.invalid_weight",
        message: `Edge weight out of range [0,1]: ${edge.from} -> ${edge.to} (${edge.weight})`,
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Graph Health Metrics — a summary of overall graph quality.
 */
export interface GraphHealthMetrics {
  healthScore: number;        // 0-100
  connectivity: number;       // largest connected component / total nodes (0-1)
  density: number;            // edges / nodes ratio
  freshness: number;          // nodes with usable status / total (0-1)
  confidenceRatio: number;    // edges with weight >= 0.8 / total edges (0-1)
  nodeCount: number;
  edgeCount: number;
  orphanNodes: number;        // nodes with no edges
  brokenEdges: number;        // edges referencing non-existent nodes
}

/**
 * Compute health metrics for a graph index.
 *
 * - connectivity: BFS from first node, count reachable / total
 * - density: edges.length / max(nodes.length, 1)
 * - freshness: simplified — nodeCount > 0 ? 1.0 : 0 (full impl needs status data)
 * - confidenceRatio: edges with weight >= 0.8 / total edges
 * - healthScore = connectivity*30 + (density>1.5?20:density/1.5*20) + freshness*25 + confidenceRatio*25
 * - orphanNodes: nodes not referenced in any edge (from or to)
 * - brokenEdges: edges where from or to is not in nodes
 */
export function computeGraphHealth(graph: GraphIndex): GraphHealthMetrics {
  const nodeCount = graph.nodes.length;
  const edgeCount = graph.edges.length;
  const slugSet = new Set(graph.nodes.map((n) => n.slug));

  // Connectivity: BFS/DFS from first node
  let connectivity = 0;
  if (nodeCount > 0) {
    const adjacency = new Map<string, Set<string>>();
    for (const node of graph.nodes) {
      adjacency.set(node.slug, new Set());
    }
    for (const edge of graph.edges) {
      if (slugSet.has(edge.from) && slugSet.has(edge.to)) {
        adjacency.get(edge.from)!.add(edge.to);
        adjacency.get(edge.to)!.add(edge.from);
      }
    }

    // BFS from the first node
    const visited = new Set<string>();
    const queue: string[] = [graph.nodes[0].slug];
    visited.add(graph.nodes[0].slug);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = adjacency.get(current);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
    }
    connectivity = visited.size / nodeCount;
  }

  // Density
  const density = edgeCount / Math.max(nodeCount, 1);

  // Freshness: simplified — if there are nodes, assume 1.0
  const freshness = nodeCount > 0 ? 1.0 : 0;

  // Confidence ratio: edges with weight >= 0.8 / total edges
  let confidenceRatio = 0;
  if (edgeCount > 0) {
    const highConfidenceEdges = graph.edges.filter((e) => (e.weight ?? 0) >= 0.8).length;
    confidenceRatio = highConfidenceEdges / edgeCount;
  }

  // Orphan nodes: nodes not referenced in any edge
  const referencedSlugs = new Set<string>();
  for (const edge of graph.edges) {
    referencedSlugs.add(edge.from);
    referencedSlugs.add(edge.to);
  }
  const orphanNodes = graph.nodes.filter((n) => !referencedSlugs.has(n.slug)).length;

  // Broken edges: edges where from or to is not in nodes
  const brokenEdges = graph.edges.filter((e) => !slugSet.has(e.from) || !slugSet.has(e.to)).length;

  // Health score
  const densityScore = density > 1.5 ? 20 : (density / 1.5) * 20;
  const healthScore = connectivity * 30 + densityScore + freshness * 25 + confidenceRatio * 25;

  return {
    healthScore,
    connectivity,
    density,
    freshness,
    confidenceRatio,
    nodeCount,
    edgeCount,
    orphanNodes,
    brokenEdges,
  };
}

/**
 * Load graph-index.json from the wiki's indices directory.
 * Canonical path: wikiRoot/.indices/graph-index.json
 * Returns null if the file doesn't exist.
 */
export async function loadGraphIndex(wikiRoot: string): Promise<GraphIndex | null> {
  const graphPath = path.join(wikiRoot, ".indices", "graph-index.json");
  try {
    const raw = await readFile(graphPath, "utf8");
    const parsed = JSON.parse(raw);
    return parseGraphIndex(parsed);
  } catch {
    return null;
  }
}

/**
 * Save graph-index.json to the wiki's indices directory.
 * Canonical path: wikiRoot/.indices/graph-index.json
 */
export async function saveGraphIndex(wikiRoot: string, graph: GraphIndex): Promise<string> {
  const dir = path.join(wikiRoot, ".indices");
  await mkdir(dir, { recursive: true });
  const outPath = path.join(dir, "graph-index.json");
  await writeFile(outPath, JSON.stringify(graph, null, 2), "utf8");
  return outPath;
}

/**
 * Merge two graphs: overlay nodes replace base nodes with same slug.
 *
 * Edges are deduplicated by from/to/relation/source. Matching edges retain
 * all evidence; richer metadata wins, with overlay preferred on ties.
 */
export function mergeGraphs(base: GraphIndex, overlay: GraphIndex): GraphIndex {
  const nodeMap = new Map<string, GraphNode>();
  const nodeKey = (n: GraphNode) => n.slug ?? (n as unknown as { id?: string }).id ?? `${n.title}:${n.type}`;
  for (const n of base.nodes) nodeMap.set(nodeKey(n), n);
  for (const n of overlay.nodes) nodeMap.set(nodeKey(n), n); // overlay wins

  const edgeMap = new Map<string, GraphEdge>();

  const evidenceLen = (e: GraphEdge) => e.evidence?.length ?? 0;
  const mergeCrossOriginPairs = (a?: string[][], b?: string[][]): string[][] | undefined => {
    if (!a && !b) return undefined;
    const seen = new Set<string>();
    const merged: string[][] = [];
    for (const pair of [...(a ?? []), ...(b ?? [])]) {
      const key = JSON.stringify([...pair].sort());
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(pair);
      }
    }
    return merged;
  };
  const edgePairs = (edge: GraphEdge): string[][] | undefined => {
    const pairs = [...(edge.crossOriginPairs ?? []), ...(edge.origin ? [[edge.origin]] : [])];
    return pairs.length === 0 ? undefined : pairs;
  };
  for (const e of [...base.edges, ...overlay.edges]) {
    const key = graphEdgeKey(e);
    const existing = edgeMap.get(key);
    if (!existing) {
      edgeMap.set(key, e);
      continue;
    }
    // Prefer the variant with more evidence; on ties, prefer overlay.
    const winner = evidenceLen(e) >= evidenceLen(existing) ? e : existing;
    const crossOriginPairs = mergeCrossOriginPairs(edgePairs(existing), edgePairs(e));
    const evidenceMap = new Map([...existing.evidence ?? [], ...e.evidence ?? []].map((item) => [JSON.stringify(item), item]));
    const merged = { ...winner, ...(evidenceMap.size ? { evidence: [...evidenceMap.values()] } : {}) };
    edgeMap.set(key, crossOriginPairs ? { ...merged, crossOriginPairs } : merged);
  }

  const httpContracts = mergeHttpContracts(base.httpContracts, overlay.httpContracts);

  return {
    schemaVersion: GRAPH_INDEX_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()],
    ...(httpContracts ? { httpContracts } : {}),
  };
}

function mergeHttpContracts(
  base?: GraphHttpContracts,
  overlay?: GraphHttpContracts,
): GraphHttpContracts | undefined {
  if (!base && !overlay) return undefined;
  const unique = <T extends { origin: string; file: string; line: number; path: string; service?: string }>(items: T[]): T[] => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const method = "method" in item
        ? (item as HttpRequestContractRecord).method
        : (item as HttpEndpointContractRecord).methods;
      const clientDefinition = "method" in item ? (item as HttpRequestContractRecord).clientDefinition : undefined;
      const key = JSON.stringify([item.origin, item.file, item.line, method, item.path, item.service, clientDefinition]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  return {
    requests: unique([...(base?.requests ?? []), ...(overlay?.requests ?? [])]),
    endpoints: unique([...(base?.endpoints ?? []), ...(overlay?.endpoints ?? [])]),
    coverage: overlay?.coverage ?? base?.coverage,
    matches: overlay?.matches ?? base?.matches,
    routingHash: overlay?.routingHash ?? base?.routingHash,
    coverageByOrigin: { ...base?.coverageByOrigin, ...overlay?.coverageByOrigin },
  };
}
