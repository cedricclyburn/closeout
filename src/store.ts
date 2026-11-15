import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Evidence, StorePort } from "./domain.ts";

const SKIP = new Set([".git", "__pycache__", "node_modules"]);

export function exportTree(source: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  copyFiltered(source, dest);
}

function copyFiltered(source: string, dest: string): void {
  for (const name of readdirSync(source)) {
    if (SKIP.has(name) || name.endsWith(".pyc")) {
      continue;
    }
    const from = path.join(source, name);
    const to = path.join(dest, name);
    if (statSync(from).isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyFiltered(from, to);
    } else {
      mkdirSync(path.dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(from));
    }
  }
}

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        found.push(full);
      }
    }
  };
  walk(dir);
  return found;
}

export function createStore(options: {
  artifactsRoot: string;
  artifactoryUrl?: string;
  artifactoryToken?: string;
  fetchImpl?: typeof fetch;
}): StorePort {
  return {
    async promote({ treePath, evidence }) {
      const versionDir = path.join(options.artifactsRoot, evidence.name, evidence.version);
      rmSync(versionDir, { recursive: true, force: true });
      const treeDir = path.join(versionDir, "tree");
      exportTree(treePath, treeDir);
      const evidencePath = path.join(versionDir, "evidence.json");
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      if (options.artifactoryUrl) {
        await putRelease(
          options.artifactoryUrl,
          options.artifactoryToken,
          versionDir,
          evidence,
          options.fetchImpl ?? fetch,
        );
      }
      return { uri: versionDir };
    },
  };
}

async function putRelease(
  baseUrl: string,
  token: string | undefined,
  versionDir: string,
  evidence: Evidence,
  fetchImpl: typeof fetch,
): Promise<void> {
  const prefix = `${evidence.name}/${evidence.version}`;
  for (const file of filesUnder(versionDir)) {
    const relative = path.relative(versionDir, file).split(path.sep).join("/");
    const target = `${baseUrl.replace(/\/$/, "")}/${prefix}/${relative}`;
    const headers: Record<string, string> = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetchImpl(target, {
      method: "PUT",
      headers,
      body: readFileSync(file),
    });
    if (!response.ok) {
      throw new Error(`artifact PUT ${relative} failed with status ${response.status}`);
    }
  }
}
