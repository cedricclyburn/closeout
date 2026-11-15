export type Pin = {
  name: string;
  pinned: string;
  fixed: string;
};

export type Location = {
  file: string;
  symbol: string;
};

export type Finding =
  | {
      id: string;
      kind: "known-upgrade";
      runtimeImport: boolean;
      pin: Pin;
    }
  | {
      id: string;
      kind: "code-defect";
      runtimeImport: boolean;
      location: Location;
    };

export type Disposition = "apply-known-upgrade" | "send-to-agent" | "refuse";

export type Phase =
  | "ingested"
  | "triaged"
  | "patching"
  | "oracle"
  | "held"
  | "releasing"
  | "deployed"
  | "rejected";

export type Outcome = "pass" | "fail";

export type CheckResult = {
  outcome: Outcome;
  detail: string;
};

export type AgentEditResult =
  | {
      outcome: "finished";
      agentId: string;
      runId: string;
    }
  | {
      outcome: "startup-error";
      message: string;
      retryable: boolean;
      agentId: string | null;
      runId: string | null;
    }
  | {
      outcome: "run-error";
      message: string;
      agentId: string;
      runId: string;
    };

export type Evidence = {
  name: string;
  version: string;
  findingIds: string[];
  disposition: Exclude<Disposition, "refuse">;
  agentId: string | null;
  runId: string | null;
  oracleResult: CheckResult;
  diffHash: string;
  releasedBy: string;
  ansibleResult: CheckResult;
};

type FindingRecord = {
  finding: Finding;
};

export type IngestedRecord = FindingRecord & {
  phase: "ingested";
};

export type TriagedRecord = FindingRecord & {
  phase: "triaged";
  disposition: Disposition;
};

export type RejectedRecord = FindingRecord & {
  phase: "rejected";
  disposition: Disposition | null;
  reason: string;
  agentId: string | null;
  runId: string | null;
};

export type HeldRecord = FindingRecord & {
  phase: "held";
  disposition: "send-to-agent";
  agentId: string;
  runId: string;
  diffHash: string;
  oracleResult: CheckResult;
  baseCommit: string;
  servicePath: string;
};

export type DeployedRecord = FindingRecord & {
  phase: "deployed";
  disposition: Exclude<Disposition, "refuse">;
  agentId: string | null;
  runId: string | null;
  diffHash: string;
  oracleResult: CheckResult;
  evidence: Evidence;
  uri: string;
};

export type GateRecord =
  | IngestedRecord
  | TriagedRecord
  | RejectedRecord
  | HeldRecord
  | DeployedRecord;

export type AgentPort = {
  edit(input: {
    cwd: string;
    prompt: string;
    agentId?: string;
  }): Promise<AgentEditResult>;
};

export type OraclePort = {
  check(input: {
    servicePath: string;
    finding: Finding;
    followUp: boolean;
  }): Promise<CheckResult>;
};

export type StorePort = {
  promote(input: { treePath: string; evidence: Evidence }): Promise<{ uri: string }>;
};

export type DeployerPort = {
  deploy(input: { releaseDir: string }): Promise<CheckResult>;
  rollback(): Promise<CheckResult>;
};

export type Ports = {
  agent: AgentPort;
  oracle: OraclePort;
  store: StorePort;
  deployer: DeployerPort;
};

export const ALLOWED_AGENT_FILE = "src/logview.py";
export const PIN_FILE = "requirements-dev.txt";
export const ARTIFACT_NAME = "closeout-sample";
