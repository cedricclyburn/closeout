import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type { Evidence } from "../src/domain.ts";
import { createStore } from "../src/store.ts";
import { tempDir, writeTree } from "./helpers.ts";

const evidence: Evidence = {
  name: "closeout-sample",
  version: "pin-ADV-2026-014",
  findingIds: ["ADV-2026-014"],
  disposition: "apply-known-upgrade",
  agentId: null,
  runId: null,
  oracleResult: { outcome: "pass", detail: "pin" },
  diffHash: "abc",
  releasedBy: "policy",
  ansibleResult: { outcome: "pass", detail: "probed" },
};

test("promotion writes the tree and the evidence file", async () => {
  const root = tempDir();
  const source = path.join(root, "tree");
  writeTree(source, {
    "src/logview.py": "fixed\n",
    "requirements-dev.txt": "widget==1.4.0\n",
  });
  try {
    const store = createStore({ artifactsRoot: path.join(root, "artifacts") });
    const saved = await store.promote({ treePath: source, evidence });
    assert.equal(readFileSync(path.join(saved.uri, "tree", "src", "logview.py"), "utf8"), "fixed\n");
    const written = JSON.parse(readFileSync(path.join(saved.uri, "evidence.json"), "utf8")) as Evidence;
    assert.deepEqual(written.findingIds, ["ADV-2026-014"]);
    assert.equal(written.agentId, null);
    assert.equal(written.releasedBy, "policy");
    assert.equal(written.oracleResult.outcome, "pass");
    assert.equal(written.ansibleResult.outcome, "pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a configured Artifactory URL receives the same files", async () => {
  const puts: string[] = [];
  const server = createServer((request, response) => {
    puts.push(`${request.method} ${request.url}`);
    response.writeHead(201);
    response.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server has no port");
  }
  const root = tempDir();
  const source = path.join(root, "tree");
  writeTree(source, { "src/server.py": "print('ok')\n" });
  try {
    const store = createStore({
      artifactsRoot: path.join(root, "artifacts"),
      artifactoryUrl: `http://127.0.0.1:${address.port}/artifactory/closeout`,
      fetchImpl: fetch,
    });
    await store.promote({ treePath: source, evidence });
    assert.ok(puts.some((line) => line.startsWith("PUT ") && line.endsWith("/evidence.json")));
    assert.ok(puts.some((line) => line.includes("/tree/src/server.py")));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(root, { recursive: true, force: true });
  }
});
