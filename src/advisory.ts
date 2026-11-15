import { readFileSync } from "node:fs";
import path from "node:path";

import { blastRadius } from "./blast.ts";
import type { Finding, Location, Pin } from "./domain.ts";

export type AdvisoryItem =
  | { id: string; kind: "known-upgrade"; pin: Pin }
  | { id: string; kind: "code-defect"; location: Location };

export function readAdvisory(file: string): AdvisoryItem[] {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { findings?: unknown }).findings)) {
    throw new Error("advisory findings missing");
  }
  return (parsed as { findings: unknown[] }).findings.map(parseItem);
}

export function enrich(servicePath: string, item: AdvisoryItem): { finding: Finding; importers: string[] } {
  const target = item.kind === "known-upgrade" ? item.pin.name : path.basename(item.location.file, ".py");
  const blast = blastRadius(servicePath, target);
  return {
    finding: { ...item, runtimeImport: blast.runtimeImport },
    importers: blast.importers,
  };
}

function parseItem(value: unknown): AdvisoryItem {
  if (!value || typeof value !== "object") {
    throw new Error("advisory finding is not an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") {
    throw new Error("advisory finding is missing an id");
  }
  if (record.kind === "known-upgrade") {
    const pin = record.pin as Partial<Pin> | undefined;
    if (!pin || typeof pin.name !== "string" || typeof pin.pinned !== "string" || typeof pin.fixed !== "string") {
      throw new Error(`advisory pin ${record.id} is incomplete`);
    }
    return { id: record.id, kind: "known-upgrade", pin: { name: pin.name, pinned: pin.pinned, fixed: pin.fixed } };
  }
  if (record.kind === "code-defect") {
    const location = record.location as Partial<Location> | undefined;
    if (!location || typeof location.file !== "string" || typeof location.symbol !== "string") {
      throw new Error(`advisory location ${record.id} is incomplete`);
    }
    return {
      id: record.id,
      kind: "code-defect",
      location: { file: location.file, symbol: location.symbol },
    };
  }
  throw new Error(`advisory kind for ${record.id} is unknown`);
}
