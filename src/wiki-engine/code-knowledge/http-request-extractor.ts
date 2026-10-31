import path from "node:path";
import type { Node, Tree } from "web-tree-sitter";

import type { CodeCollectedFile } from "./code-collector.js";
import type { HttpRequestContract } from "./http-contract.js";
import { codeFileId } from "./code-identity.js";
import { ensureAstReady, getLanguage, getParser, grammarForExtension } from "./ast/parser-registry.js";
import { resolveImportSpecifier, resetImportResolverCache } from "./ast/import-resolver.js";
import type { WikiEvidence } from "../core/wiki-protocol.js";

interface Module {
  file: CodeCollectedFile;
  tree: Tree;
  values: Map<string, Node>;
  imports: Map<string, { module?: Module; source: string; name: string }>;
  defaultExport?: Node;
}

interface Value {
  text?: string;
  node?: Node;
  module: Module;
  evidence: WikiEvidence[];
  method?: string;
  reason?: string;
  registry?: boolean;
  baseURL?: string;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const children = (node?: Node): Node[] => node?.namedChildren.filter((child): child is Node => child !== null) ?? [];
const field = (node: Node, key: string): Node | undefined => node.childForFieldName(key) ?? undefined;
const evidence = (module: Module, node: Node, origin: string): WikiEvidence => ({
  ref: codeFileId(origin, module.file.relativePath), lineStart: node.startPosition.row + 1, type: "config",
});

function visit(node: Node, run: (node: Node) => void): void {
  run(node);
  for (const child of children(node)) visit(child, run);
}

function literal(node?: Node): string | undefined {
  if (!node) return undefined;
  if (node.type === "number") return node.text;
  if (node.type !== "string" && node.type !== "template_string") return undefined;
  if (children(node).some((child) => child.type === "template_substitution")) return undefined;
  // Escaped literals need a real JS decoder; retain them as unresolved rather
  // than changing an HTTP path by stripping escape characters.
  return node.text.includes("\\") ? undefined : node.text.slice(1, -1);
}

function property(node: Node | undefined, name: string): Node | undefined {
  if (!node || node.type !== "object") return undefined;
  const pair = children(node).find((child) => child.type === "pair" &&
    (literal(field(child, "key")) ?? field(child, "key")?.text) === name);
  return pair ? field(pair, "value") : undefined;
}

function unwrap(node: Node | undefined): Node | undefined {
  while (node && ["parenthesized_expression", "as_expression", "satisfies_expression"].includes(node.type)) node = children(node)[0];
  return node;
}

function shadowed(name: string, call: Node): boolean {
  for (let scope = call.parent; scope && scope.type !== 'program'; scope = scope.parent) {
    const parameters = field(scope, 'parameters') ?? field(scope, 'parameter');
    let parameterHit = false;
    if (parameters) visit(parameters, (node) => { if (node.type === 'identifier' && node.text === name) parameterHit = true; });
    if (parameterHit) return true;
    if (scope.type === 'statement_block') {
      for (const statement of children(scope)) {
        if (statement.type !== 'lexical_declaration' && statement.type !== 'variable_declaration') continue;
        for (const declaration of children(statement)) {
          if (field(declaration, 'name')?.text === name) return true;
        }
      }
    }
  }
  return false;
}

function visitUrlReferences(node: Node, run: (node: Node) => void): void {
  // API builders have a declared path template; runtime query/path values
  // passed as arguments do not change the identity of that template.
  if (node.type === 'call_expression') {
    const callee = field(node, 'function');
    if (callee) visitUrlReferences(callee, run);
    return;
  }
  if (node.type === 'member_expression') {
    const receiver = field(node, 'object');
    if (receiver) visitUrlReferences(receiver, run);
    return;
  }
  run(node);
  for (const child of children(node)) visitUrlReferences(child, run);
}

/** Static extraction only: parses source but never imports or executes a project. */
export async function extractRequestContracts(
  files: CodeCollectedFile[], origin: string, repoRoot?: string,
): Promise<HttpRequestContract[]> {
  await ensureAstReady();
  resetImportResolverCache();
  const modules = new Map<string, Module>();
  const parser = getParser();
  try {
    for (const file of files) {
      const variant = grammarForExtension(path.extname(file.relativePath));
      if (variant !== "typescript" && variant !== "tsx") continue;
      parser.setLanguage(getLanguage(variant));
      const tree = parser.parse(file.content);
      if (!tree) continue;
      const module: Module = { file, tree, values: new Map(), imports: new Map() };
      for (const statement of children(tree.rootNode)) {
        const declaration = statement.type === "export_statement" ? children(statement)[0] : statement;
        if (declaration?.type === "lexical_declaration" || declaration?.type === "variable_declaration") {
          for (const item of children(declaration)) {
            const name = field(item, "name"), value = field(item, "value");
            if (name?.type === "identifier" && value && declaration.text.startsWith('const ')) module.values.set(name.text, value);
          }
        }
        if (statement.type === "export_statement" && statement.text.startsWith("export default")) {
          module.defaultExport = children(statement)[0];
        }
      }
      modules.set(file.relativePath, module);
    }
    for (const module of modules.values()) {
      for (const statement of children(module.tree.rootNode).filter((node) => node.type === "import_statement")) {
        if (/^import\s+type\b/u.test(statement.text)) continue;
        const source = literal(field(statement, "source"));
        if (!source) continue;
        let imported: Module | undefined;
        if (repoRoot) {
          const resolved = await resolveImportSpecifier(repoRoot, module.file.relativePath, source, async (file) => modules.has(file));
          imported = resolved ? modules.get(resolved.targetFile) : undefined;
        } else if (source.startsWith(".")) {
          const base = path.posix.normalize(path.posix.join(path.posix.dirname(module.file.relativePath), source));
          imported = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`].map((key) => modules.get(key)).find(Boolean);
        }
        const clause = children(statement).find((node) => node.type === "import_clause");
        if (!clause) continue;
        for (const item of children(clause)) {
          if (item.type === "identifier") module.imports.set(item.text, { module: imported, source, name: "default" });
          if (item.type === "namespace_import") {
            const name = children(item).at(-1)?.text;
            if (name) module.imports.set(name, { module: imported, source, name: "*" });
          }
          if (item.type === "named_imports") {
            for (const specifier of children(item)) {
              const name = field(specifier, "name")?.text, alias = field(specifier, "alias")?.text ?? name;
              if (name && alias) module.imports.set(alias, { module: imported, source, name });
            }
          }
        }
      }
    }

    const evaluate = (node: Node | undefined, module: Module, depth = 0): Value => {
      const result: Value = { module, node, evidence: [] };
      if (!node || depth > 20) return { ...result, reason: "Dynamic URL" };
      const text = literal(node);
      if (text !== undefined) return { ...result, text };
      if (["parenthesized_expression", "as_expression", "satisfies_expression"].includes(node.type)) {
        return evaluate(children(node)[0], module, depth + 1);
      }
      if (node.type === "identifier") {
        const value = module.values.get(node.text);
        if (value) return { ...evaluate(value, module, depth + 1), evidence: [evidence(module, value, origin)] };
        const binding = module.imports.get(node.text);
        if (binding?.module) {
          const target = binding.module;
          if (binding.name === "*") return { ...result, module: target, node: target.tree.rootNode };
          if (binding.name === "default" && target.values.has("APICollection") && unwrap(target.defaultExport)?.type === "call_expression") {
            return { ...result, module: target, registry: true };
          }
          return evaluate(binding.name === "default" ? target.defaultExport : target.values.get(binding.name), target, depth + 1);
        }
        return { ...result, reason: "Dynamic URL" };
      }
      if (node.type === "member_expression") {
        const key = field(node, "property")?.text;
        const base = evaluate(field(node, "object"), module, depth + 1);
        if (!key) return { ...result, reason: "Dynamic URL" };
        if (base.registry) {
          const collection = base.module.values.get("APICollection");
          const ref = property(collection, key) ?? children(collection!).find((child) => child.type === "shorthand_property_identifier" && child.text === key);
          const binding = ref ? base.module.imports.get(ref.text) : undefined;
          if (!binding?.module) return { ...result, reason: "Unresolved API definition" };
          const target = binding.module;
          const host = evaluate(target.values.get("HOST"), target, depth + 1);
          const hostNode = target.values.get("HOST");
          const hosts = hostNode?.type === "array" ? children(hostNode).map(literal) : [];
          const staticHost = host.text ?? (hosts.length > 0 && hosts.every((candidate) => candidate !== undefined && candidate === hosts[0]) ? hosts[0] : undefined);
          return { module: target, node: target.values.get("API"), evidence: [evidence(target, hostNode ?? target.tree.rootNode, origin)], baseURL: staticHost, reason: staticHost ? undefined : "Dynamic API host" };
        }
        const value = base.node?.type === "program" ? base.module.values.get(key) : property(base.node, key);
        const resolved = evaluate(value, base.module, depth + 1);
        return { ...resolved, baseURL: base.baseURL ?? resolved.baseURL, reason: base.reason ?? resolved.reason, evidence: [...base.evidence, ...resolved.evidence] };
      }
      if (node.type === "object" || node.type === "program") return result;
      if (node.type === "call_expression") {
        const callee = field(node, "function");
        const args = children(field(node, "arguments")!);
        const definedMethod = /^define(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/u.exec(callee?.text ?? "")?.[1];
        if (definedMethod && module.imports.has(callee!.text)) {
          const value = evaluate(args[0], module, depth + 1);
          return { ...value, method: definedMethod, evidence: [...value.evidence, evidence(module, node, origin)] };
        }
        const value = evaluate(callee, module, depth + 1);
        if (value.text !== undefined) {
          // Named API builders substitute path slots at runtime. Preserve the
          // declared template for matching; runtime values are not literals.
          return { ...value, evidence: [...value.evidence, evidence(value.module, value.node ?? node, origin)] };
        }
        return { ...value, reason: value.reason ?? "Dynamic URL" };
      }
      return { ...result, reason: "Dynamic URL" };
    };

    const isHttp = (name: string, module: Module, depth = 0): boolean => {
      if (depth > 8) return false;
      if (name === "axios" && !module.imports.has(name)) return true;
      const binding = module.imports.get(name);
      if (binding?.source === "axios") return true;
      if (binding?.module?.defaultExport?.type === "identifier") return isHttp(binding.module.defaultExport.text, binding.module, depth + 1);
      const value = module.values.get(name);
      return value?.type === "call_expression" && field(value, "function")?.text.endsWith(".create") === true &&
        isHttp(field(field(value, "function")!, "object")?.text ?? "", module, depth + 1);
    };
    const clientBaseURL = (name: string, module: Module, depth = 0): Value | undefined => {
      if (depth > 8) return undefined;
      const binding = module.imports.get(name);
      if (binding?.module && binding.name === "default") {
        const exported = unwrap(binding.module.defaultExport);
        if (exported?.type === "identifier") return clientBaseURL(exported.text, binding.module, depth + 1);
      }
      const value = module.values.get(name);
      if (value?.type === "call_expression" && field(value, "function")?.text.endsWith(".create")) {
        const config = children(field(value, "arguments")!)[0];
        return evaluate(property(config, "baseURL"), module);
      }
      return undefined;
    };
    const requests: HttpRequestContract[] = [];
    for (const module of modules.values()) visit(module.tree.rootNode, (node) => {
      if (node.type !== "call_expression" || node.hasError) return;
      const callee = field(node, "function"), argsNode = field(node, "arguments");
      if (!callee || !argsNode) return;
      const args = children(argsNode);
      let target: Node | undefined, config: Node | undefined, method: string | undefined;
      let methodFromConfig = false;
      if (callee.type === "identifier" && callee.text === "fetch" && !module.imports.has("fetch") && !module.values.has('fetch') && !shadowed('fetch', node)) {
        target = args[0]; config = args[1]; method = "GET";
        methodFromConfig = true;
      } else if (callee.type === "member_expression") {
        const receiver = field(callee, "object"), member = field(callee, "property")?.text;
        if (!member || !receiver) return;
        if (receiver.type === 'identifier' && shadowed(receiver.text, node)) return;
        if (receiver.type === "identifier" && isHttp(receiver.text, module)) {
          if (!HTTP_METHODS.has(member) && member !== "request") return;
          config = member === "request" ? args[0] : args[["post", "put", "patch"].includes(member) ? 2 : 1];
          target = member === "request" ? property(config, "url") : args[0];
          method = member === "request" ? "GET" : member.toUpperCase();
          methodFromConfig = member === "request";
        } else if (HTTP_METHODS.has(member) && evaluate(receiver, module).text !== undefined) {
          target = receiver; method = member.toUpperCase(); config = args[0];
        } else return;
      } else if (callee.type === "identifier" && /^(?:useSWR|useTypedSWR)$/u.test(callee.text) && module.imports.has(callee.text)) {
        config = args[0];
        // Function keys have explicit return expressions; an arbitrary
        // conditional key cannot be interpreted as an unconditional request.
        if (config?.type === "arrow_function") {
          config = field(config, "body");
          if (config?.type === "parenthesized_expression") config = children(config)[0];
        }
        target = property(config, "url") ?? (config?.type === "object" ? undefined : config);
        method = "GET";
        methodFromConfig = true;
      } else return;
      const value = evaluate(target, module);
      if (target) visitUrlReferences(target, (reference) => {
        if (reference.type === 'identifier' && shadowed(reference.text, node)) {
          value.text = undefined; value.reason = 'Dynamic local URL';
        }
      });
      const methodNode = property(config, "method");
      if (methodNode && methodFromConfig) method = literal(methodNode)?.toUpperCase();
      let rawPath = value.text ?? "";
      if (value.baseURL && rawPath) rawPath = `${value.baseURL.replace(/\/$/u, "")}/${rawPath.replace(/^\//u, "")}`;
      let service: string | undefined, requestPath = rawPath;
      let reason = value.reason;
      const receiver = callee.type === "member_expression" ? field(callee, "object") : undefined;
      const configBase = property(config, "baseURL");
      const base = configBase ? evaluate(configBase, module) : receiver?.type === "identifier" ? clientBaseURL(receiver.text, module) : undefined;
      if (base) {
        if (base.text && rawPath && !/^https?:\/\//u.test(rawPath)) {
          rawPath = `${base.text.replace(/\/$/u, "")}/${rawPath.replace(/^\//u, "")}`;
          requestPath = rawPath;
          value.evidence.push(...base.evidence);
        } else if (!base.text) reason = "Dynamic baseURL";
      }
      if (/^https?:\/\//u.test(rawPath)) {
        try { const url = new URL(rawPath); service = url.hostname; requestPath = url.pathname; } catch { reason = "Invalid URL"; }
      }
      if (!rawPath) reason ??= "Dynamic URL";
      if (rawPath && !rawPath.startsWith("/") && !/^https?:\/\//u.test(rawPath) && /^(?:useSWR|useTypedSWR)$/u.test(callee.text)) {
        reason = "Unresolved SWR key";
        requestPath = "";
      }
      if (!method) reason = "Dynamic HTTP method";
      if (method && !HTTP_METHODS.has(method.toLowerCase())) reason = "Unsupported HTTP method";
      requests.push({
        origin, file: module.file.relativePath, line: node.startPosition.row + 1,
        method: method ?? "", path: requestPath, ...(service ? { service } : {}),
        ...(reason ? { unresolvedReason: reason } : {}),
        evidence: [{ ...evidence(module, node, origin), type: "usage" }, ...value.evidence],
      });
    });
    return requests;
  } finally {
    for (const module of modules.values()) module.tree.delete();
  }
}
