import type { CodeCollectedFile } from "./code-collector.js";
import type { AstHttpEndpoint } from "./ast/types.js";
import type { GraphEdge, HttpContractCoverage } from "../core/graph-index.schema.js";
import { codeFileId } from "./code-identity.js";
import type { WikiEvidence } from "../core/wiki-protocol.js";
import { extractRequestContracts } from "./http-request-extractor.js";

export interface HttpRequestContract {
  origin: string;
  file: string;
  line: number;
  method: string;
  path: string;
  /** Source of the API catalog or client; inline requests use their caller file. */
  clientDefinition?: string;
  service?: string;
  unresolvedReason?: string;
  evidence?: WikiEvidence[];
}

export interface HttpEndpointContract {
  origin: string;
  file: string;
  line: number;
  methods?: string[];
  path: string;
  service?: string;
  evidence?: WikiEvidence[];
}

export interface HttpContractMatch {
  request: HttpRequestContract;
  endpoint?: HttpEndpointContract;
  confidence: "EXTRACTED" | "AMBIGUOUS";
  reason?: string;
  resolution?: {
    path: string;
    service: string;
    backendOrigin: string;
    evidence: WikiEvidence[];
  };
}

export function astEndpointsToHttpContracts(
  endpoints: AstHttpEndpoint[],
  origin: string,
  service?: string,
): HttpEndpointContract[] {
  return endpoints.flatMap((endpoint) => endpoint.paths.map((path) => ({
    origin,
    file: endpoint.file,
    line: endpoint.line,
    methods: endpoint.methods,
    path: normalizeHttpPath(path),
    service,
  })));
}

/** Emits only formal, uniquely matched HTTP edges, with request and endpoint evidence. */
export function httpMatchesToGraphEdges(matches: HttpContractMatch[]): GraphEdge[] {
  return matches.flatMap((match) => {
    if (match.confidence !== "EXTRACTED" || !match.endpoint) return [];
    return [{
      from: codeFileId(match.request.origin, match.request.file),
      to: codeFileId(match.endpoint.origin, match.endpoint.file),
      relation: "CALLS_HTTP" as const,
      source: "code-http" as const,
      origin: match.request.origin,
      weight: 1,
      evidence: [
        { ref: codeFileId(match.request.origin, match.request.file), lineStart: match.request.line, lineEnd: match.request.line, note: `${match.request.method} ${match.request.path} -> ${match.resolution?.service ?? match.request.service}` },
        { ref: codeFileId(match.endpoint.origin, match.endpoint.file), lineStart: match.endpoint.line, lineEnd: match.endpoint.line, note: `${match.request.method} ${match.endpoint.path} <- ${match.endpoint.service}` },
        ...(match.request.evidence ?? []), ...(match.endpoint.evidence ?? []),
        ...(match.resolution?.evidence ?? []),
      ],
    }];
  });
}

export function httpContractCoverage(
  filesScanned: number,
  filesParsed: number,
  requests: HttpRequestContract[],
  endpoints: HttpEndpointContract[],
  matches: HttpContractMatch[],
  filesFailed = 0,
  filesUnsupported = 0,
): HttpContractCoverage {
  const uniqueMatches = matches.filter((match) => match.confidence === "EXTRACTED").length;
  const unresolved = matches.filter((match) => match.confidence !== "EXTRACTED" &&
    match.reason !== "Multiple matching endpoints" && match.reason !== "No matching endpoint").length;
  return {
    filesScanned,
    filesParsed,
    filesFailed,
    filesUnsupported,
    requests: requests.length,
    endpoints: endpoints.length,
    uniqueMatches,
    candidates: matches.length - uniqueMatches - unresolved,
    unresolved,
  };
}

export async function extractHttpRequests(files: CodeCollectedFile[], origin: string, repoRoot?: string): Promise<HttpRequestContract[]> {
  return (await extractRequestContracts(files, origin, repoRoot)).map((request) => ({
    ...request, path: request.path ? normalizeHttpPath(request.path) : "",
  }));
}

export function normalizeHttpPath(value: string): string {
  const path = `/${value.split(/[?#]/u)[0]}`.replace(/\/+/g, "/").replace(/:([\w]+)/gu, "{$1}");
  return path.length > 1 ? path.replace(/\/$/u, "") : path;
}

/** Unconstrained path parameter names do not change a route's URL shape. */
function httpPathShape(value: string): string {
  return normalizeHttpPath(value).replace(/\{[\w$]+\}/gu, "{}");
}

/** A formal dependency exists only for a unique method/path/resolved-service endpoint. */
export function matchHttpContracts(requests: HttpRequestContract[], endpoints: HttpEndpointContract[]): HttpContractMatch[] {
  return requests.map((request) => {
    if (request.unresolvedReason || !request.path || !request.method || !request.service) {
      return { request, confidence: "AMBIGUOUS", reason: request.unresolvedReason ?? "Unresolved service" };
    }
    const candidates = endpoints.filter((endpoint) =>
      endpoint.service === request.service
      && httpPathShape(endpoint.path) === httpPathShape(request.path)
      && (endpoint.methods === undefined || endpoint.methods.includes(request.method)));
    if (candidates.length === 1) return { request, endpoint: candidates[0], confidence: "EXTRACTED" };
    return { request, confidence: "AMBIGUOUS", reason: candidates.length === 0 ? "No matching endpoint" : "Multiple matching endpoints" };
  });
}
