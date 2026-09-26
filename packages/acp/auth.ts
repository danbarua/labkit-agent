import { RequestError, type AuthMethod, type ClientCapabilities } from "@agentclientprotocol/sdk";
import { z } from "zod";

import type { ClientElicitation } from "./client-elicitation.ts";
import { waitForBoundary } from "./session-config.ts";

export type AcpAuthContext = Readonly<{ elicitation: ClientElicitation }>;

export type AcpAuth = Readonly<{
  methods: readonly AuthMethod[];
  /** Read credential availability; never put credentials in the returned protocol metadata. */
  isAuthenticated: () => boolean;
  authenticate?: (
    methodId: string,
    signal: AbortSignal,
    context: AcpAuthContext,
  ) => void | Promise<void>;
  logout?: (signal: AbortSignal) => void | Promise<void>;
}>;

const common = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  description: z.string().max(4096).nullish(),
  _meta: z.record(z.string(), z.json()).nullish(),
});
const MethodSchema = z.union([
  common.strict(),
  common
    .extend({
      type: z.literal("terminal"),
      args: z.array(z.string()).max(128).optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
]);

/** One connection's auth state: advertised methods, the access check and credential changes. */
export type BoundAuth = Readonly<{
  logoutSupported: boolean;
  methods(capabilities: ClientCapabilities): AuthMethod[];
  requireAccess(): void;
  authenticate(
    methodId: string,
    signal: AbortSignal,
    before: () => Promise<void>,
    context?: AcpAuthContext,
  ): Promise<void>;
  logout(signal: AbortSignal, before: () => Promise<void>): Promise<void>;
}>;

/** Auth is a host binding, independent of journaled session policy and once-only tool approvals. */
export function bindAuth(binding?: AcpAuth): BoundAuth {
  const methods: AuthMethod[] = z
    .array(MethodSchema)
    .max(32)
    .parse(binding?.methods ?? []);
  if (new Set(methods.map((method) => method.id)).size !== methods.length)
    throw new Error("Authentication method IDs must be unique");
  if (Buffer.byteLength(JSON.stringify(methods)) > 65536)
    throw new Error("Authentication metadata exceeds 64 KiB");
  const authenticate = binding?.authenticate;
  const logout = binding?.logout;
  const isAuthenticated = binding?.isAuthenticated;
  if (methods.some((method) => !("type" in method)) && !authenticate)
    throw new Error("Agent authentication methods require an authenticate callback");
  let busy = false;
  let permitted = true;
  const requireAccess = () => {
    if (binding && (busy || !permitted || isAuthenticated?.() !== true))
      throw RequestError.authRequired();
  };
  const transition = (operation: () => Promise<void>, signal: AbortSignal, grant = false) => {
    signal.throwIfAborted();
    if (busy) throw new RequestError(-32000, "Authentication change is already in progress");
    busy = true;
    permitted = false;
    const pending = (async () => {
      await operation();
      signal.throwIfAborted();
      permitted = grant;
    })().finally(() => {
      busy = false;
    });
    // A cancelled callback retains the lock until it settles; its late result cannot grant access.
    return waitForBoundary(pending, signal);
  };
  return {
    logoutSupported: !!logout,
    methods(capabilities: ClientCapabilities) {
      return structuredClone(
        methods.filter((method) => !("type" in method) || capabilities.auth?.terminal === true),
      );
    },
    requireAccess,
    authenticate(
      methodId: string,
      signal: AbortSignal,
      before: () => Promise<void>,
      context: AcpAuthContext = { elicitation: {} },
    ) {
      if (!binding || !authenticate) throw RequestError.methodNotFound("authenticate");
      const method = methods.find((method) => method.id === methodId);
      if (!method || "type" in method) {
        const advertised = methods.filter((method) => !("type" in method)).map(({ id }) => id);
        throw RequestError.invalidParams(
          { methodId, advertised },
          `${JSON.stringify(methodId)} is not ${method ? "an agent authentication method (terminal login runs from the client)" : "an advertised agent authentication method"}; advertised agent authentication method IDs: ${advertised.map((id) => JSON.stringify(id)).join(", ") || "none"}`,
        );
      }
      return transition(
        async () => {
          await before();
          signal.throwIfAborted();
          await authenticate(methodId, signal, context);
          signal.throwIfAborted();
          if (isAuthenticated?.() !== true) throw RequestError.authRequired();
        },
        signal,
        true,
      );
    },
    logout(signal: AbortSignal, before: () => Promise<void>) {
      if (!logout) throw RequestError.methodNotFound("logout");
      return transition(async () => {
        await before();
        signal.throwIfAborted();
        await logout(signal);
        signal.throwIfAborted();
        if (isAuthenticated?.() !== false)
          throw new RequestError(-32000, "Logout did not clear authentication");
      }, signal);
    },
  };
}
