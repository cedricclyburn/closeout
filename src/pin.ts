import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { PIN_FILE, type Pin } from "./domain.ts";

export function pinPath(servicePath: string): string {
  return path.join(servicePath, PIN_FILE);
}

export function applyPin(servicePath: string, pin: Pin): void {
  const file = pinPath(servicePath);
  const before = readFileSync(file, "utf8");
  const from = `${pin.name}==${pin.pinned}`;
  const to = `${pin.name}==${pin.fixed}`;
  if (!before.includes(from)) {
    throw new Error(`missing pin ${from}`);
  }
  writeFileSync(file, before.replaceAll(from, to));
}
