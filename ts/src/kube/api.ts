// The whole Kubernetes client: one fetch wrapper. Locally it talks to
// `kubectl proxy`, which holds the credentials; in a pod it talks to the
// API service with the mounted service-account token. No SDK, so nothing to
// load.
import { readFileSync } from "node:fs";
import { config } from "../config.js";

export class KubeError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function kube<T = any>(
  method: string,
  path: string,
  body?: unknown,
  contentType = "application/json",
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = contentType;
  // Read on every call: projected service-account tokens rotate.
  if (config.kubeTokenFile)
    headers.authorization = `Bearer ${readFileSync(config.kubeTokenFile, "utf8").trim()}`;
  const res = await fetch(config.kubeApi + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok)
    throw new KubeError(
      res.status,
      `${method} ${path} -> ${res.status} ${text.slice(0, 240)}`,
    );
  return (
    (res.headers.get("content-type") ?? "").includes("json")
      ? JSON.parse(text)
      : text
  ) as T;
}
