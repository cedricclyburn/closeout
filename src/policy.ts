import type { Disposition, Finding } from "./domain.ts";

export function dispositionFor(finding: Finding): Disposition {
  if (finding.kind === "known-upgrade" && !finding.runtimeImport) {
    return "apply-known-upgrade";
  }
  if (finding.kind === "code-defect" && finding.runtimeImport) {
    return "send-to-agent";
  }
  return "refuse";
}
