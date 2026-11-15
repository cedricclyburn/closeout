import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SKIP = new Set([".git", "__pycache__", "node_modules", "var", "logs"]);

const IMPORT_LINE = /^\s*import\s+([A-Za-z_][\w.]*)/;
const FROM_LINE = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/;
const IMPORT_MODULE = /importlib\.import_module\(\s*["']([A-Za-z_][\w.]*)["']\s*\)/g;

export type BlastRadius = {
  runtimeImport: boolean;
  importers: string[];
};

type ParsedFile = {
  rel: string;
  module: string;
  imports: string[];
};

function relativePosix(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function pythonFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) {
        continue;
      }
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (name.endsWith(".py")) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

function importedNames(source: string): string[] {
  const names: string[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      continue;
    }
    const direct = IMPORT_LINE.exec(line) ?? FROM_LINE.exec(line);
    if (direct?.[1]) {
      names.push(direct[1]);
    }
    for (const match of line.matchAll(IMPORT_MODULE)) {
      if (match[1]) {
        names.push(match[1]);
      }
    }
  }
  return names;
}

function importsTarget(imported: string, target: string): boolean {
  return imported === target || imported.startsWith(`${target}.`);
}

export function blastRadius(root: string, target: string): BlastRadius {
  const files: ParsedFile[] = pythonFiles(root).map((file) => ({
    rel: relativePosix(root, file),
    module: path.basename(file, ".py"),
    imports: importedNames(readFileSync(file, "utf8")),
  }));

  const importers = new Set<string>();
  const reached = new Set<string>([target]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const file of files) {
      if (importers.has(file.rel)) {
        continue;
      }
      const hits = file.imports.some((name) =>
        [...reached].some((mod) => importsTarget(name, mod)),
      );
      if (!hits) {
        continue;
      }
      importers.add(file.rel);
      reached.add(file.module);
      grew = true;
    }
  }

  const listed = [...importers].sort();
  return {
    runtimeImport: listed.some((file) => file.startsWith("src/")),
    importers: listed,
  };
}
