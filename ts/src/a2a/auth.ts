// A2A lets any caller that can reach the port run an agent and its tools,
// so the port needs a lock. One shared bearer token (A2A_TOKEN) covers this
// project: servers reject requests without it, clients attach it. With no
// token the servers only listen on loopback, which is the local dev case.
import type { RequestHandler } from "express";
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from "@a2a-js/sdk/client";
import { sameSecret } from "../secret.js";

const token = process.env.A2A_TOKEN ?? "";
export const listenHost = process.env.LISTEN_HOST ?? "127.0.0.1";

export function assertSafeToListen(): void {
  const loopback =
    listenHost === "127.0.0.1" ||
    listenHost === "localhost" ||
    listenHost === "::1";
  if (!token && !loopback)
    throw new Error(
      "refusing to serve A2A on a non-loopback address without A2A_TOKEN",
    );
}

/**
 * Discovery (the agent card) and health stay open; everything else needs
 * the token.
 */
export const requireToken: RequestHandler = (req, res, next) => {
  const open =
    req.path.startsWith("/.well-known/") || req.path === "/healthz";
  const given = req.headers.authorization ?? "";
  if (!token || open || sameSecret(given, `Bearer ${token}`)) {
    next();
    return;
  }
  res.status(401).json({ error: "missing or wrong A2A bearer token" });
};

const authFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
};

export function clientFactory(): ClientFactory {
  return new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl: authFetch })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
  });
}
