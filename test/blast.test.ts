import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { blastRadius } from "../src/blast.ts";
import { tempDir, writeTree } from "./helpers.ts";

test("runtime import follows the server, and a dev script does not", () => {
  const root = tempDir();
  writeTree(root, {
    "src/server.py": "from logview import read_log\n",
    "src/logview.py": "def read_log(name):\n    return name\n",
    "scripts/dev_check.py": "def load_pinned_package():\n    import widget\n    return widget\n",
  });
  try {
    const logview = blastRadius(root, "logview");
    assert.equal(logview.runtimeImport, true);
    assert.deepEqual(logview.importers, ["src/server.py"]);

    const widget = blastRadius(root, "widget");
    assert.equal(widget.runtimeImport, false);
    assert.deepEqual(widget.importers, ["scripts/dev_check.py"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an import reached only through src is runtime, including one hop away", () => {
  const root = tempDir();
  writeTree(root, {
    "src/server.py": "import app\n",
    "src/app.py": "from logview import read_log\n",
    "src/logview.py": "def read_log(name):\n    return name\n",
    "scripts/wrap.py": "import dev_check\n",
    "scripts/dev_check.py": "import widget\n",
  });
  try {
    const logview = blastRadius(root, "logview");
    assert.equal(logview.runtimeImport, true);
    assert.deepEqual(logview.importers, ["src/app.py", "src/server.py"]);

    const widget = blastRadius(root, "widget");
    assert.equal(widget.runtimeImport, false);
    assert.deepEqual(widget.importers, ["scripts/dev_check.py", "scripts/wrap.py"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("comments are not imports", () => {
  const root = tempDir();
  writeTree(root, {
    "src/server.py": "# import widget\nfrom logview import read_log\n",
    "src/logview.py": "x = 1\n",
  });
  try {
    assert.equal(blastRadius(root, "widget").runtimeImport, false);
    assert.deepEqual(blastRadius(root, "widget").importers, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
