import assert from "node:assert/strict";
import { test } from "node:test";

import { dispositionFor } from "../src/policy.ts";
import type { Finding } from "../src/domain.ts";

const pin = {
  name: "widget",
  pinned: "1.2.0",
  fixed: "1.4.0",
};

test("a known pin that runtime code does not import is applied with no agent", () => {
  const finding: Finding = {
    id: "ADV-2026-014",
    kind: "known-upgrade",
    runtimeImport: false,
    pin,
  };
  assert.equal(dispositionFor(finding), "apply-known-upgrade");
});

test("a known pin imported by runtime code is refused", () => {
  const finding: Finding = {
    id: "ADV-2026-014",
    kind: "known-upgrade",
    runtimeImport: true,
    pin,
  };
  assert.equal(dispositionFor(finding), "refuse");
});

test("a runtime code defect is sent to the agent", () => {
  const finding: Finding = {
    id: "ADV-2026-015",
    kind: "code-defect",
    runtimeImport: true,
    location: { file: "src/logview.py", symbol: "read_log" },
  };
  assert.equal(dispositionFor(finding), "send-to-agent");
});

test("a code defect that runtime code does not import is refused", () => {
  const finding: Finding = {
    id: "ADV-2026-015",
    kind: "code-defect",
    runtimeImport: false,
    location: { file: "src/logview.py", symbol: "read_log" },
  };
  assert.equal(dispositionFor(finding), "refuse");
});
