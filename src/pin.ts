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

const PIN_LINE = /^([A-Za-z0-9][\w.-]*)==(\S+)$/;

function pinsIn(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = PIN_LINE.exec(line.trim());
    if (match) {
      found.set(match[1], match[2]);
    }
  }
  return found;
}

function versionBelow(left: string, right: string): boolean {
  const a = left.split(".");
  const b = right.split(".");
  const count = Math.max(a.length, b.length);
  for (let index = 0; index < count; index += 1) {
    const av = Number(a[index] ?? 0);
    const bv = Number(b[index] ?? 0);
    if (Number.isNaN(av) || Number.isNaN(bv)) {
      return false;
    }
    if (av < bv) {
      return true;
    }
    if (av > bv) {
      return false;
    }
  }
  return false;
}

export function keepShippedPins(shippedText: string, candidateText: string): string {
  const shipped = pinsIn(shippedText);
  let next = candidateText;
  const candidate = pinsIn(candidateText);
  for (const [name, version] of shipped) {
    const have = candidate.get(name);
    if (have === undefined) {
      const separator = next.length === 0 || next.endsWith("\n") ? "" : "\n";
      next = `${next}${separator}${name}==${version}\n`;
      continue;
    }
    if (versionBelow(have, version)) {
      next = next.replaceAll(`${name}==${have}`, `${name}==${version}`);
    }
  }
  return next;
}
