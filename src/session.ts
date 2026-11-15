import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { GateRecord } from "./domain.ts";

export type Session = {
  worktree: string;
  baseCommit: string;
  records: GateRecord[];
};

export function sessionFile(root: string): string {
  return path.join(root, "var", "session.json");
}

export function saveSession(root: string, session: Session): void {
  const file = sessionFile(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(session, null, 2)}\n`);
}

export function loadSession(root: string): Session {
  const parsed: unknown = JSON.parse(readFileSync(sessionFile(root), "utf8"));
  if (!parsed || typeof parsed !== "object") {
    throw new Error("session file is unreadable");
  }
  const session = parsed as Partial<Session>;
  if (typeof session.worktree !== "string" || typeof session.baseCommit !== "string" || !Array.isArray(session.records)) {
    throw new Error("session file is unreadable");
  }
  return session as Session;
}

export function replaceRecord(session: Session, record: GateRecord): Session {
  const records = session.records.filter((item) => item.finding.id !== record.finding.id);
  records.push(record);
  return { ...session, records };
}
