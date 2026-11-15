import { ALLOWED_AGENT_FILE, type Finding } from "./domain.ts";

export function defectPrompt(finding: Extract<Finding, { kind: "code-defect" }>): string {
  const file = finding.location.file;
  const symbol = finding.location.symbol;
  return [
    `Fix a path traversal in ${file}, function ${symbol}.`,
    "The function joins a log directory with a caller-supplied name and opens that path.",
    'A name containing a ".." segment can escape the log directory.',
    "Raise an exception for those names. Do not return the escaped file.",
    "A normal relative name such as app.log must still be readable.",
    `Edit only ${ALLOWED_AGENT_FILE}.`,
    "Do not commit.",
    "Do not add dependencies.",
    "Do not create or edit tests.",
    "Use the Python standard library only.",
  ].join("\n");
}

export function followUpSentence(sentence: string): string {
  const text = sentence.trim();
  if (text.length === 0) {
    throw new Error("follow-up sentence is empty");
  }
  return text;
}
