import type { TurnCommand } from "../../agent/agent-fsm.ts";
import type { ActorId } from "../../agent/types.ts";
import type { HostContext } from "../context.ts";
import type { ExecutionContext } from "../host.ts";
import { completeModel } from "./model.ts";
import { requestPermission } from "./permission.ts";
import { runTools } from "./tools.ts";

/**
 * A host command with a specific type.
 */
export type HostCommand<K extends TurnCommand["type"]> = Extract<TurnCommand, { type: K }>;

/**
 * Handler function for a host command of type K.
 */
export type HostCommandHandler<K extends TurnCommand["type"]> = (
  host: HostContext,
  turnId: ActorId,
  command: HostCommand<K>,
  context: ExecutionContext,
) => void;

/**
 * Table of command handlers indexed by command type.
 * Each handler is responsible for spawning the appropriate child operation.
 */
const hostCommands: { readonly [K in TurnCommand["type"]]: HostCommandHandler<K> } = {
  cancel: (host, _turnId, command) => host.cancel(command.child),
  complete: completeModel,
  request_permission: requestPermission,
  run_tools: runTools,
};

/**
 * Runs the handler registered for `type` on a command of that type.
 */
export function runHostCommand<K extends TurnCommand["type"]>(
  host: HostContext,
  turnId: ActorId,
  type: K,
  command: HostCommand<K>,
  context: ExecutionContext,
): void {
  hostCommands[type](host, turnId, command, context);
}
