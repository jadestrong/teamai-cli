import path from "node:path";

import { type CodeFact, isMetadataRelation } from "./code-extractors.js";
import {
  type GraphIndex,
  type GraphNode,
  type GraphEdge,
  type RelationType,
  createGraphIndex,
} from "../core/graph-index.schema.js";
import { codeFileId, normalizeRelativeCodePath } from "./code-identity.js";

/**
 * Build a GraphIndex from raw code facts.
 * Nodes: one scoped node per collected or referenced code file.
 * Edges: DEPENDS_ON edges from relation facts (internal imports only).
 */
export function buildCodeGraph(facts: CodeFact[], options: { origin: string; files?: string[] }): GraphIndex {
  const codeId = (file: string) => codeFileId(options.origin, file);
  const files = new Map<string, GraphNode>();
  const addFile = (relativePath: string, confidence: GraphNode["confidence"] = "EXTRACTED") => {
    const file = normalizeRelativeCodePath(relativePath);
    if (files.has(file)) return;
    files.set(file, {
      slug: codeId(file),
      type: "component",
      confidence,
      title: path.basename(file),
      domain: path.dirname(file).split("/")[0] || undefined,
      origin: options.origin,
      path: file,
    });
  };
  for (const file of options.files ?? []) addFile(file);
  for (const fact of facts) addFile(fact.file, fact.confidence);
  // AST resolution already verifies target existence, including imported
  // assets and files that have no declarations of their own.
  for (const fact of facts) {
    const edge = fact.kind === "relation" ? parseAstRelationFact(fact) : undefined;
    if (edge) addFile(edge.to);
  }
  const targetIndex = new Map<string, string[]>();
  for (const file of files.keys()) {
    const parts = file.replace(/\.(?:[cm]?[jt]sx?|java|scala)$/u, "").split("/");
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(i).join("/");
      targetIndex.set(key, [...(targetIndex.get(key) ?? []), file]);
    }
  }
  const edges = facts
    .filter((fact) => fact.kind === "relation" && !isMetadataRelation(fact.name))
    .flatMap((fact) => {
      const astEdge = parseAstRelationFact(fact);
      if (astEdge) return astEdge.from === astEdge.to && astEdge.relation !== "IMPLEMENTS" ? [] : [{ ...astEdge, from: codeId(astEdge.from), to: codeId(astEdge.to), evidence: astEdge.evidence?.map((item) => ({ ...item, ref: codeId(item.ref) })), origin: options.origin }];
      const name = fact.file.endsWith(".java") ? fact.name.replace(/\./gu, "/") : fact.name;
      const target = name.startsWith(".")
        ? path.posix.normalize(path.posix.join(path.posix.dirname(fact.file), name))
        : name;
      const matches = files.has(target) ? [target] : targetIndex.get(target.replace(/\.(?:[cm]?[jt]sx?|java|scala)$/u, "")) ?? [];
      const targets = matches.length === 1 && matches[0] !== fact.file ? matches : [];
      return targets.map((file) => ({
        from: codeId(fact.file), to: codeId(file), relation: "DEPENDS_ON" as const,
        weight: 0.8, source: "code-heuristic" as const, origin: options.origin,
        evidence: [{ ref: codeId(fact.file), lineStart: fact.lineStart, type: "usage" as const }],
      }));
    });
  return createGraphIndex([...files.values()], edges);
}

/**
 * Parse an AST-derived relation fact into a precise graph edge.
 *
 * AST facts encode their edge as `detail = "<RELATION> → <target> (code-ast)"`
 * with `fact.name` already holding the resolved target file. Returns undefined
 * for heuristic relation facts, which require a unique path target.
 */
function parseAstRelationFact(fact: CodeFact): GraphEdge | undefined {
  if (!fact.detail.includes("(code-ast)")) {
    return undefined;
  }
  const relation: RelationType = fact.detail.startsWith("REFERENCES")
    ? "REFERENCES"
    : fact.detail.startsWith("IMPLEMENTS")
      ? "IMPLEMENTS"
      : "DEPENDS_ON";
  return {
    from: fact.file,
    to: fact.name,
    relation,
    weight: fact.confidence === "EXTRACTED" ? 0.9 : 0.5,
    source: "code-ast",
    evidence: [{ ref: fact.file, lineStart: fact.lineStart, lineEnd: fact.lineEnd, type: "usage" }],
  };
}
