import { describe, expect, it } from "vitest";

import { extractHttpRequests, httpMatchesToGraphEdges, matchHttpContracts } from "../wiki-engine/code-knowledge/http-contract.js";

describe("HTTP contract extraction", () => {
  it("matches a unique static axios request to an endpoint", async () => {
    const requests = await extractHttpRequests([{ path: "/virtual/request.ts", relativePath: "src/request.ts", language: "typescript", sha256: "x", content: 'axios.post("https://api/api/orders", body);' }], "web");
    const matches = matchHttpContracts(requests, [{ origin: "api", file: "Orders.java", line: 10, methods: ["POST"], path: "/api/orders", service: "api" }]);
    expect(matches).toEqual([
      expect.objectContaining({ confidence: "EXTRACTED", endpoint: expect.objectContaining({ origin: "api" }) }),
    ]);
    expect(httpMatchesToGraphEdges(matches)).toEqual([
      expect.objectContaining({ from: "code://web/src/request.ts", to: "code://api/Orders.java", relation: "CALLS_HTTP", source: "code-http" }),
    ]);
  });

  it("keeps multiple endpoints ambiguous", async () => {
    const requests = await extractHttpRequests([{ path: "/virtual/request.ts", relativePath: "src/request.ts", language: "typescript", sha256: "x", content: 'fetch("https://gateway/api/orders", { method: "GET" });' }], "web");
    expect(matchHttpContracts(requests, [
      { origin: "api-a", file: "A.java", line: 1, methods: ["GET"], path: "/api/orders", service: "gateway" },
      { origin: "api-b", file: "B.java", line: 1, methods: ["GET"], path: "/api/orders", service: "gateway" },
    ])[0]).toMatchObject({ confidence: "AMBIGUOUS", reason: "Multiple matching endpoints" });
  });

  it("keeps relative URLs unresolved instead of guessing a service", async () => {
    const requests = await extractHttpRequests([{ path: "/virtual/request.ts", relativePath: "src/request.ts", language: "typescript", sha256: "x", content: 'fetch("/api/orders");' }], "web");
    expect(matchHttpContracts(requests, [{ origin: "api", file: "A.java", line: 1, methods: ["GET"], path: "/api/orders", service: "api" }])[0])
      .toMatchObject({ confidence: "AMBIGUOUS", reason: "Unresolved service" });
  });

  it("matches AMS id templates to Spring planId templates without changing evidence", () => {
    const request = { origin: "web", file: "request.ts", line: 32, method: "GET", path: "/deposit_applications/plans/{id}/histories", service: "funding-site" };
    const endpoint = { origin: "funding", file: "DepositApplicationCtrl.java", line: 653, methods: ["GET"], path: "/deposit_applications/plans/{planId}/histories", service: "funding-site" };
    const matches = matchHttpContracts([request], [endpoint]);
    expect(matches[0]).toEqual({ request, endpoint, confidence: "EXTRACTED" });
    const edge = httpMatchesToGraphEdges(matches)[0];
    expect(edge.evidence?.[0].note).toContain(request.path);
    expect(edge.evidence?.[1].note).toContain(endpoint.path);
  });

  it("keeps equivalent named templates ambiguous when more than one endpoint exists", () => {
    const request = { origin: "web", file: "request.ts", line: 1, method: "GET", path: "/plans/{id}", service: "funding-site" };
    expect(matchHttpContracts([request], [
      { origin: "funding", file: "A.java", line: 1, methods: ["GET"], path: "/plans/{planId}", service: "funding-site" },
      { origin: "funding", file: "B.java", line: 1, methods: ["GET"], path: "/plans/{otherId}", service: "funding-site" },
    ])[0]).toMatchObject({ confidence: "AMBIGUOUS", reason: "Multiple matching endpoints" });
  });

  it.each([
    { path: "/plans/{planId}/histories", methods: ["POST"], service: "funding-site" },
    { path: "/plans/{planId}/histories", methods: ["GET"], service: "funding-bos" },
    { path: "/plans/{planId}/details", methods: ["GET"], service: "funding-site" },
    { path: "/plans/{planId:[0-9]+}/histories", methods: ["GET"], service: "funding-site" },
    { path: "/plans/{planId}/{extra}/histories", methods: ["GET"], service: "funding-site" },
  ])("does not infer a template match across different route constraints: $path $methods $service", (endpoint) => {
    const request = { origin: "web", file: "request.ts", line: 1, method: "GET", path: "/plans/{id}/histories", service: "funding-site" };
    expect(matchHttpContracts([request], [{ origin: "funding", file: "A.java", line: 1, ...endpoint }])[0])
      .toMatchObject({ confidence: "AMBIGUOUS", reason: "No matching endpoint" });
  });
});
