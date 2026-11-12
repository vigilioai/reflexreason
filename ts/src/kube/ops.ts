// Everything the agents may see or do in the cluster. Reads build an
// Evidence record; writes are the three reversible actions the runbooks
// allow. There is deliberately no delete here: an operation that does not
// exist cannot be talked into running.
import { config } from "../config.js";
import type { Evidence } from "../types.js";
import { kube, KubeError } from "./api.js";

const WAITING_FAULTS = new Set([
  "ImagePullBackOff",
  "ErrImagePull",
  "InvalidImageName",
  "CrashLoopBackOff",
  "CreateContainerConfigError",
]);
const NOT_READY_GRACE_SEC = 20;
const age = (iso?: string): number =>
  iso ? (Date.now() - Date.parse(iso)) / 1000 : 0;
const pods = (ns: string): string => `/api/v1/namespaces/${ns}/pods`;
const apps = (ns: string, kind: string): string =>
  `/apis/apps/v1/namespaces/${ns}/${kind}`;

export interface Unhealthy {
  namespace: string;
  workload: string;
  pod: string;
  reason: string;
}

/**
 * Primary symptom of a pod, or "" when the cluster considers it healthy.
 */
function symptom(pod: any): string {
  const cs = pod.status?.containerStatuses?.[0];
  const waiting = cs?.state?.waiting?.reason as string | undefined;
  if (waiting && WAITING_FAULTS.has(waiting)) return waiting;
  const scheduled = pod.status?.conditions?.find(
    (c: any) => c.type === "PodScheduled",
  );
  if (scheduled?.status === "False" && scheduled.reason === "Unschedulable")
    return "Unschedulable";
  if (cs?.state?.terminated && cs.state.terminated.exitCode !== 0)
    return cs.state.terminated.reason ?? "Error";
  const ready = pod.status?.conditions?.find(
    (c: any) => c.type === "Ready",
  );
  if (
    pod.status?.phase === "Running" &&
    ready?.status === "False" &&
    age(ready.lastTransitionTime) > NOT_READY_GRACE_SEC
  ) {
    return "NotReady";
  }
  return "";
}

const workloadOf = (pod: any): string =>
  pod.metadata?.labels?.app ??
  String(pod.metadata?.name ?? "").replace(/-[a-z0-9]+-[a-z0-9]+$/, "");

/**
 * One entry per unhealthy workload, not per pod: replicas share a cause.
 */
export async function listUnhealthy(
  namespace: string,
): Promise<Unhealthy[]> {
  const list = await kube(`GET`, pods(namespace));
  const seen = new Map<string, Unhealthy>();
  for (const pod of list.items ?? []) {
    if (pod.metadata?.deletionTimestamp) continue;
    const reason = symptom(pod);
    const workload = workloadOf(pod);
    if (reason && !seen.has(workload))
      seen.set(workload, {
        namespace,
        workload,
        pod: pod.metadata.name,
        reason,
      });
  }
  return [...seen.values()];
}

/** Pods the cluster calls healthy; their logs may still say otherwise. */
export async function listHealthy(namespace: string): Promise<Unhealthy[]> {
  const list = await kube("GET", pods(namespace));
  return (list.items ?? [])
    .filter(
      (p: any) =>
        !p.metadata?.deletionTimestamp &&
        p.status?.phase === "Running" &&
        symptom(p) === "",
    )
    .map((p: any) => ({
      namespace,
      workload: workloadOf(p),
      pod: p.metadata.name,
      reason: "LogAnomaly",
    }));
}

export async function podLogs(
  namespace: string,
  pod: string,
  tail = 200,
  previous = false,
): Promise<string> {
  const q = `tailLines=${tail}${previous ? "&previous=true" : ""}`;
  try {
    return await kube<string>("GET", `${pods(namespace)}/${pod}/log?${q}`);
  } catch (e) {
    if (e instanceof KubeError && e.status === 400) return "";
    throw e;
  }
}

export async function podEvents(
  namespace: string,
  pod: string,
): Promise<string[]> {
  const list = await kube(
    "GET",
    `/api/v1/namespaces/${namespace}/events?fieldSelector=involvedObject.name%3D${pod}`,
  );
  const seen = new Set<string>();
  for (const e of list.items ?? [])
    if (e.type === "Warning")
      seen.add(`${e.reason}: ${String(e.message).slice(0, 200)}`);
  return [...seen].slice(-6);
}

interface History {
  revision: number;
  revisions: number;
  secondsSinceRollout: number | null;
  sets: any[];
}

export async function rolloutHistory(
  namespace: string,
  deployment: string,
): Promise<History> {
  const all = await kube("GET", apps(namespace, "replicasets"));
  const sets = (all.items ?? [])
    .filter((rs: any) =>
      rs.metadata?.ownerReferences?.some(
        (o: any) => o.kind === "Deployment" && o.name === deployment,
      ),
    )
    .sort((a: any, b: any) => rev(a) - rev(b));
  const newest = sets.at(-1);
  return {
    revision: newest ? rev(newest) : 0,
    revisions: sets.length,
    secondsSinceRollout:
      sets.length > 1 && newest
        ? Math.round(age(newest.metadata.creationTimestamp))
        : null,
    sets,
  };
}
const rev = (rs: any): number =>
  Number(
    rs.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? 0,
  );

export async function describe(
  namespace: string,
  podName: string,
  reasonHint = "",
): Promise<Evidence> {
  const pod = await kube("GET", `${pods(namespace)}/${podName}`);
  const cs = pod.status?.containerStatuses?.[0];
  const container = pod.spec?.containers?.[0];
  const workload = workloadOf(pod);
  const last = cs?.lastState?.terminated ?? cs?.state?.terminated;
  const [history, events, current] = await Promise.all([
    rolloutHistory(namespace, workload),
    podEvents(namespace, podName),
    podLogs(namespace, podName),
  ]);
  // A container that is waiting to restart has an empty current log; the
  // reason it died is in the previous one.
  const log =
    current.trim() === "" && (cs?.restartCount ?? 0) > 0
      ? await podLogs(namespace, podName, 200, true)
      : current;
  const limit = container?.resources?.limits?.memory as string | undefined;
  return {
    namespace,
    workload,
    pod: podName,
    phase: pod.status?.phase ?? "Unknown",
    ready:
      pod.status?.conditions?.some(
        (c: any) => c.type === "Ready" && c.status === "True",
      ) ?? false,
    reason: symptom(pod) || reasonHint || "Healthy",
    lastTerminated: last
      ? `${last.reason ?? "Error"} exit ${last.exitCode}`
      : "",
    exitCode: last?.exitCode ?? null,
    restarts: cs?.restartCount ?? 0,
    image: container?.image ?? "",
    memoryLimitMi: limit ? toMi(limit) : null,
    revision: history.revision,
    revisions: history.revisions,
    secondsSinceRollout: history.secondsSinceRollout,
    events,
    log,
  };
}

function toMi(q: string): number {
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|M|G)?$/.exec(q);
  if (!m) return 0;
  const n = Number(m[1]);
  return Math.round(
    { Ki: n / 1024, Mi: n, Gi: n * 1024, M: n * 0.9537, G: n * 953.7 }[
      m[2] ?? ""
    ] ?? n / 1048576,
  );
}

/** True when every replica runs the current spec and is available. */
export async function rolloutStatus(
  namespace: string,
  deployment: string,
): Promise<{ done: boolean; ready: number; want: number }> {
  const d = await kube(
    "GET",
    `${apps(namespace, "deployments")}/${deployment}`,
  );
  const want = d.spec?.replicas ?? 1;
  const st = d.status ?? {};
  const done =
    (st.observedGeneration ?? 0) >= (d.metadata?.generation ?? 0) &&
    (st.updatedReplicas ?? 0) === want &&
    (st.replicas ?? 0) === want &&
    (st.availableReplicas ?? 0) === want;
  return { done, ready: st.availableReplicas ?? 0, want };
}

const dry = (dryRun: boolean): string => (dryRun ? "?dryRun=All" : "");
const STRATEGIC = "application/strategic-merge-patch+json";

/**
 * `kubectl rollout undo`: put the previous ReplicaSet's pod template back.
 */
export async function rolloutUndo(
  namespace: string,
  deployment: string,
  dryRun: boolean,
): Promise<string> {
  const { sets } = await rolloutHistory(namespace, deployment);
  const previous = sets.at(-2);
  if (!previous)
    throw new Error(`no earlier revision of ${deployment} to return to`);
  const template = structuredClone(previous.spec.template);
  delete template.metadata?.labels?.["pod-template-hash"];
  await kube(
    "PATCH",
    `${apps(namespace, "deployments")}/${deployment}${dry(dryRun)}`,
    [{ op: "replace", path: "/spec/template", value: template }],
    "application/json-patch+json",
  );
  return `rolled ${deployment} back to revision ${rev(previous)}`;
}

/** `kubectl rollout restart`: a new pod generation with the same spec. */
export async function rolloutRestart(
  namespace: string,
  deployment: string,
  dryRun: boolean,
): Promise<string> {
  const patch = {
    spec: {
      template: {
        metadata: {
          annotations: {
            "kubectl.kubernetes.io/restartedAt": new Date().toISOString(),
          },
        },
      },
    },
  };
  await kube(
    "PATCH",
    `${apps(namespace, "deployments")}/${deployment}${dry(dryRun)}`,
    patch,
    STRATEGIC,
  );
  return `restarted ${deployment}`;
}

export async function setMemoryLimit(
  namespace: string,
  deployment: string,
  memoryMi: number,
  dryRun: boolean,
): Promise<string> {
  const dep = await kube(
    "GET",
    `${apps(namespace, "deployments")}/${deployment}`,
  );
  const name = dep.spec.template.spec.containers[0].name;
  const patch = {
    spec: {
      template: {
        spec: {
          containers: [
            { name, resources: { limits: { memory: `${memoryMi}Mi` } } },
          ],
        },
      },
    },
  };
  await kube(
    "PATCH",
    `${apps(namespace, "deployments")}/${deployment}${dry(dryRun)}`,
    patch,
    STRATEGIC,
  );
  return `set ${deployment} memory limit to ${memoryMi}Mi`;
}

/** Leave an audit trail on the object that was changed. */
export async function annotate(
  namespace: string,
  deployment: string,
  note: Record<string, unknown>,
): Promise<void> {
  const patch = {
    metadata: {
      annotations: { "oncall.rr/last-action": JSON.stringify(note) },
    },
  };
  await kube(
    "PATCH",
    `${apps(namespace, "deployments")}/${deployment}`,
    patch,
    STRATEGIC,
  );
}

/**
 * One agent per workload. A Lease is the Kubernetes primitive for this:
 * create wins, a 409 means someone else holds it, and an expired holder may
 * be replaced with a compare-and-swap on resourceVersion.
 */
export async function acquireLease(
  key: string,
  holder: string,
  ttlSec: number,
): Promise<{ acquired: boolean; holder: string }> {
  const name = "rr-" + key.replace(/[^a-z0-9]+/g, "-");
  const base =
    "/apis/coordination.k8s.io/v1/namespaces/" +
    `${config.leaseNamespace}/leases`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, ".000000Z");
  const spec = {
    holderIdentity: holder,
    leaseDurationSeconds: ttlSec,
    acquireTime: now,
    renewTime: now,
  };
  try {
    await kube("POST", base, {
      apiVersion: "coordination.k8s.io/v1",
      kind: "Lease",
      metadata: { name },
      spec,
    });
    return { acquired: true, holder };
  } catch (e) {
    if (!(e instanceof KubeError) || e.status !== 409) throw e;
  }
  const lease = await kube("GET", `${base}/${name}`);
  const expired =
    age(lease.spec?.renewTime) >
    (lease.spec?.leaseDurationSeconds ?? ttlSec);
  if (!expired && lease.spec?.holderIdentity !== holder)
    return { acquired: false, holder: lease.spec?.holderIdentity ?? "?" };
  try {
    await kube("PUT", `${base}/${name}`, { ...lease, spec });
    return { acquired: true, holder };
  } catch (e) {
    if (e instanceof KubeError && e.status === 409)
      return { acquired: false, holder: "raced" };
    throw e;
  }
}
