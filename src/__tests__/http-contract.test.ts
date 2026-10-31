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
});
