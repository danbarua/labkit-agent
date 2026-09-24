import type { SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk";
import { PolicyPatchSchema, type Policy, type PolicyPatch } from "@labkit-agent/core/policy";
import { z } from "zod";

/** Pure selectors and patches. Their selected values live only in the journaled core policy. */
export type AcpConfigBinding = Readonly<{
  id: string;
  name: string;
  description?: string;
  category?: string;
  current: (policy: Policy) => string;
  options: readonly Readonly<{
    value: string;
    name: string;
    description?: string;
    patch: PolicyPatch;
  }>[];
}>;
const metadata = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
});
const choice = z.object({
  value: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  patch: PolicyPatchSchema,
});
export function bindConfig(
  bindings: readonly AcpConfigBinding[] = [],
): readonly AcpConfigBinding[] {
  const ids = new Set<string>();
  let modes = 0;
  return bindings.map((binding) => {
    const fields = metadata.parse(binding);
    if (ids.has(fields.id)) throw new Error("Duplicate ACP config ID");
    ids.add(fields.id);
    if (fields.category === "mode" && ++modes > 1)
      throw new Error("Only one ACP mode selector is supported");
    if (typeof binding.current !== "function")
      throw new Error("ACP config requires a policy selector");
    const options = binding.options.map((value) => choice.parse(structuredClone(value)));
    if (!options.length || new Set(options.map((value) => value.value)).size !== options.length)
      throw new Error("ACP config choices must be nonempty and unique");
    return { ...fields, current: binding.current, options };
  });
}
export function configState(
  bindings: readonly AcpConfigBinding[],
  policy: Policy | undefined,
): { configOptions?: SessionConfigOption[]; modes?: SessionModeState } {
  if (!bindings.length) return {};
  if (!policy) throw new Error("ACP config requires journaled policy");
  const configOptions: SessionConfigOption[] = bindings.map(({ current, options, ...fields }) => {
    const currentValue = current(policy);
    if (!options.some((option) => option.value === currentValue))
      throw new Error(`Stored policy is not represented by ACP config ${fields.id}`);
    return {
      ...fields,
      type: "select",
      currentValue,
      options: options.map(({ patch: _, ...option }) => option),
    };
  });
  const mode = configOptions.find((option) => option.category === "mode");
  const modeBinding = bindings.find((binding) => binding.category === "mode");
  return {
    configOptions,
    ...(mode && modeBinding
      ? {
          modes: {
            currentModeId: String(mode.currentValue),
            availableModes: modeBinding.options.map(({ value, name, description }) => ({
              id: value,
              name,
              ...(description ? { description } : {}),
            })),
          },
        }
      : {}),
  };
}
/** Stop waiting on cancellation even when a host callback does not honor its signal. */
export function waitForBoundary<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
