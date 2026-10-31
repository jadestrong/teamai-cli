import path from "node:path";
import { parse } from "yaml";

import type { CodeCollectedFile } from "./code-collector.js";
import type { AstHttpEndpoint } from "./ast/types.js";
import type { HttpEndpointContract } from "./http-contract.js";
import { normalizeHttpPath } from "./http-contract.js";
import { codeFileId } from "./code-identity.js";
import type { WikiEvidence } from "../core/wiki-protocol.js";

interface ServiceConfig { root: string; service?: string; prefix?: string; evidence: WikiEvidence[] }

/** Resolve each Java module from its own Spring configuration, never a repo label. */
export function resolveSpringHttpEndpoints(endpoints: AstHttpEndpoint[], files: CodeCollectedFile[], origin: string): HttpEndpointContract[] {
  const configs: ServiceConfig[] = [];
  for (const file of files) {
    if (!/(?:^|\/)application(?:-[\w-]+)?\.(?:properties|ya?ml)$/u.test(file.relativePath)) continue;
    const config: Record<string, string> = {};
    if (file.relativePath.endsWith(".properties")) {
      for (const line of file.content.split(/\r?\n/u)) {
        const pair = /^\s*([\w.-]+)\s*[=:]\s*(.*?)\s*$/u.exec(line);
        if (pair) config[pair[1]] = pair[2];
      }
    } else {
      let data: { spring?: { application?: { name?: string }; mvc?: { servlet?: { path?: string } } }; server?: { servlet?: { "context-path"?: string } } };
      try { data = parse(file.content); } catch { continue; }
      config["spring.application.name"] = data?.spring?.application?.name ?? "";
      config["server.servlet.context-path"] = data?.server?.servlet?.["context-path"] ?? "";
      config["spring.mvc.servlet.path"] = data?.spring?.mvc?.servlet?.path ?? "";
    }
    const service = config["spring.application.name"];
    const context = config["server.servlet.context-path"] ?? config["server.context-path"] ?? "";
    const servlet = config["spring.mvc.servlet.path"] ?? "";
    const dynamic = [service, context, servlet].some((value) => typeof value !== "string" || value.includes("${"));
    const resourcePrefix = /^(.*?)\/?src\/main\/resources\//u.exec(file.relativePath);
    const root = resourcePrefix ? resourcePrefix[1] : path.posix.dirname(file.relativePath);
    configs.push({
      root, service: dynamic || !service ? undefined : service,
      prefix: dynamic ? undefined : normalizeHttpPath(`${context}/${servlet}`),
      evidence: [{ ref: codeFileId(origin, file.relativePath), lineStart: Math.max(1, file.content.split(/\r?\n/u).findIndex((line) => line.includes("spring.application.name") || line.includes("name:")) + 1), type: "config", note: "Spring application identity and servlet prefix" }],
    });
  }
  return endpoints.flatMap((endpoint) => {
    const applicable = configs.filter((config) => !config.root || endpoint.file.startsWith(`${config.root}/`)).sort((a, b) => b.root.length - a.root.length);
    const selected = applicable[0];
    const peers = applicable.filter((candidate) => candidate.root === selected?.root);
    const config = selected && peers.every((candidate) => candidate.service === selected.service && candidate.prefix === selected.prefix)
      ? { ...selected, evidence: peers.flatMap((candidate) => candidate.evidence) } : undefined;
    return endpoint.paths.map((endpointPath) => ({
      origin, file: endpoint.file, line: endpoint.line, methods: endpoint.methods,
      path: normalizeHttpPath(`${config?.prefix ?? ""}/${endpointPath}`),
      ...(config?.service ? { service: config.service } : {}),
      evidence: [
        { ref: codeFileId(origin, endpoint.file), lineStart: endpoint.line, type: "definition" as const },
        ...(config?.evidence ?? []),
      ],
    }));
  });
}
