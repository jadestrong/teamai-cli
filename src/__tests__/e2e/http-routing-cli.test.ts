import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import type { GraphIndex } from '../../wiki-engine/core/graph-index.schema.js';
import type { HttpRoutingConfig } from '../../http-routing.js';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

describe('HTTP routing real CLI', () => {
  it('generates inventory, links multiple services, refreshes config-only imports and removes stale source matches', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'teamai-routing-cli-'));
    const output = path.join(root, 'out');
    const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args, '--output', output], { cwd: root, encoding: 'utf8' });
    const readGraph = async () => JSON.parse(await readFile(path.join(output, 'teamwiki/.indices/graph-index.json'), 'utf8')) as GraphIndex;
    try {
      const files = {
        'web/http.ts': 'import axios from "axios"; export default axios;',
        'web/define.ts': 'export const defineGET = (path: string) => path;',
        'web/TRADE.ts': 'import { defineGET } from "./define"; export const API = { site: defineGET("/funding/plans/:id"), bos: defineGET("/bos/plans/:id"), other: defineGET("/unknown/plans/:id") }; export const HOST = runtimeHost;',
        'web/API.ts': 'import * as TRADE from "./TRADE"; const APICollection = { TRADE }; export default Object.keys(APICollection).reduce(enhance, {}) as APIPicker;',
        'web/request.ts': 'import http from "./http"; import API from "./API"; export function request(id: string) { http.get(API.TRADE.site({id})); http.get(API.TRADE.bos({id})); http.get(API.TRADE.other({id})); }',
        'api/src/main/resources/application.properties': 'spring.application.name=funding-site\n',
        'api/src/main/java/Site.java': 'import org.springframework.web.bind.annotation.*;\n@RestController public class Site { @GetMapping("/plans/{planId}") public Object get() { return null; } }',
        'bos/src/main/resources/application.properties': 'spring.application.name=funding-bos\n',
        'bos/src/main/java/Bos.java': 'import org.springframework.web.bind.annotation.*;\n@RestController public class Bos { @GetMapping("/plans/{otherId}") public Object get() { return null; } }',
      };
      for (const [file, text] of Object.entries(files)) { const target = path.join(root, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, text); }
      const web = path.join(root, 'web');
      execFileSync('git', ['init', '-q', web]);
      execFileSync('git', ['-C', web, 'add', '.']);
      execFileSync('git', ['-C', web, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']);
      for (const name of ['web', 'api', 'bos']) run('import', '--dir', path.join(root, name), '--skip-enrich');
      expect((await readGraph()).httpContracts?.coverage?.uniqueMatches).toBe(0);
      const preview = JSON.parse(run('--dry-run', 'codebase', '--init-http-routing', '--json'));
      expect(preview).toMatchObject({ clients: 1, requests: 3, backends: 2, dryRun: true });
      const file = path.join(output, 'teamwiki/http-routing.yaml');
      await expect(readFile(file)).rejects.toThrow();
      run('codebase', '--init-http-routing');
      const config = parse(await readFile(file, 'utf8')) as HttpRoutingConfig;
      const client = config.frontends[0].clients[0];
      expect(client.definition).toBe('TRADE.ts');
      client.routes = [
        { path: '/funding/(.*)', rewrite: '/$1', backend: { origin: 'api', service: 'funding-site' } },
        { path: '/bos/(.*)', rewrite: '/$1', backend: { origin: 'bos', service: 'funding-bos' } },
      ];
      await writeFile(file, stringify(config));
      const initial = JSON.parse(run('codebase', '--reconcile', '--json'));
      expect(initial.httpRouting).toMatchObject({ uniqueMatches: 2, updated: true });
      let graph = await readGraph();
      expect(graph.edges.filter((e) => e.relation === 'CALLS_HTTP')).toHaveLength(2);
      expect(graph.httpContracts?.requests.every((r) => r.unresolvedReason === 'Dynamic API host')).toBe(true);
      const original = await readFile(path.join(output, 'teamwiki/.indices/graph-index.json'), 'utf8');
      expect(JSON.parse(run('codebase', '--reconcile', '--json')).httpRouting.updated).toBe(false);
      expect(await readFile(path.join(output, 'teamwiki/.indices/graph-index.json'), 'utf8')).toBe(original);
      expect(JSON.parse(run('codebase', '--lint', '--json')).summary.high).toBe(0);

      client.routes.pop();
      await writeFile(file, stringify(config));
      expect(run('import', '--dir', web, '--skip-enrich', '--incremental')).toContain('source unchanged; HTTP routing refreshed');
      graph = await readGraph();
      expect(graph.httpContracts?.coverage?.uniqueMatches).toBe(1);
      expect(graph.edges.filter((e) => e.relation === 'CALLS_HTTP')).toHaveLength(1);
      const afterIncremental = await readFile(path.join(output, 'teamwiki/.indices/graph-index.json'), 'utf8');
      run('codebase', '--reconcile', '--json');
      expect(await readFile(path.join(output, 'teamwiki/.indices/graph-index.json'), 'utf8')).toBe(afterIncremental);
      await writeFile(path.join(web, 'TRADE.ts'), files['web/TRADE.ts'].replace('/funding/plans/:id', '/funding/missing/:id'));
      run('import', '--dir', web, '--skip-enrich', '--incremental');
      expect((await readGraph()).edges.filter((e) => e.relation === 'CALLS_HTTP')).toHaveLength(0);
      expect(await readFile(path.join(output, 'teamwiki/http-links.md'), 'utf8')).toContain('0 uniquely matched');
      run('codebase', '--init-http-routing');
      const refreshed = parse(await readFile(file, 'utf8')) as HttpRoutingConfig;
      expect(refreshed.frontends[0].clients[0].routes[0]).toEqual(client.routes[0]);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);
});
