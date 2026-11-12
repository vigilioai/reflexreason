export type FaultClass =
  | "image_pull"
  | "crash_config"
  | "oom"
  | "probe"
  | "stale_app"
  | "unschedulable"
  | "unknown";

export type Action =
  "rollout_undo" | "rollout_restart" | "raise_memory" | "escalate";

/**
 * What the cluster says about one unhealthy workload. Facts only, no
 * judgement.
 */
export interface Evidence {
  namespace: string;
  workload: string;
  pod: string;
  phase: string;
  ready: boolean;
  reason: string;
  lastTerminated: string;
  exitCode: number | null;
  restarts: number;
  image: string;
  memoryLimitMi: number | null;
  revision: number;
  revisions: number;
  secondsSinceRollout: number | null;
  events: string[];
  log: string;
}

export interface Template {
  pattern: string;
  count: number;
  level: number;
  sample: string;
}

export interface Distilled {
  fingerprint: string;
  key: string;
  lines: number;
  bytes: number;
  templates: Template[];
}

export interface Runbook {
  id: string;
  title: string;
  faultClass: FaultClass;
  autoAction: Action;
  maxMemoryFactor?: number;
  text: string;
  probability: number;
}

export interface IncidentRecord {
  fingerprint: string;
  workload: string;
  reason: string;
  faultClass: FaultClass;
  classProbability: number;
  injectionProbability: number;
  runbook: string | null;
  runbookProbability: number;
  action: Action;
  executed: boolean;
  recovered: boolean | null;
  escalatedTo: "none" | "reason" | "human";
  why: string;
  state: string;
  reasonAnswer: string;
  ms: Record<string, number>;
  decisionCalls: number;
}
