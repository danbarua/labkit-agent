import type { TurnCommand } from "../../agent/agent-fsm.ts";
import type { ActorId } from "../../agent/types.ts";
import type { HostContext } from "../context.ts";
import type { ExecutionContext } from "../host.ts";
import { prepareHandoff } from "./handoff.ts";
import { completeModel, prepareModel } from "./model.ts";

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
export const hostCommands: { readonly [K in TurnCommand["type"]]: HostCommandHandler<K> } = {
  cancel: (host, _turnId, command) => host.cancel(command.child),
  prepare_model: prepareModel,
  complete: completeModel,
  prepare_handoff: prepareHandoff,
  request_permission: undefined as unknown as HostCommandHandler<"request_permission">,
  run_tools: undefined as unknown as HostCommandHandler<"run_tools">,
};
