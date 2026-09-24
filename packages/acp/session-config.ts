import type { SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk";
import { PolicyPatchSchema, type Policy, type PolicyPatch } from "@labkit-agent/core/policy";
import { z } from "zod";

type ConfigMetadata = Readonly<{
  id: string;
  name: string;
  description?: string;
  category?: string;
}>;
export type AcpSelectBinding = ConfigMetadata &
  Readonly<{
    type?: "select";
    current: (policy: Policy) => string;
    options: readonly Readonly<{
      value: string;
      name: string;
      description?: string;
      patch: PolicyPatch;
    }>[];
  }>;
export type AcpBooleanBinding = ConfigMetadata &
  Readonly<{
    type: "boolean";
    current: (policy: Policy) => boolean;
    patches: Readonly<{ true: PolicyPatch; false: PolicyPatch }>;
  }>;
/** Pure selectors and patches. Selected values live only in journaled core policy. */
export type AcpConfigBinding = AcpSelectBinding | AcpBooleanBinding;
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
  booleanSupported = false,
): readonly AcpConfigBinding[] {
  const ids = new Set<string>();
  let modes = 0;
  return bindings
    .map((binding): AcpConfigBinding => {
      const fields = metadata.parse(binding);
      if (ids.has(fields.id)) throw new Error("Duplicate ACP config ID");
      ids.add(fields.id);
      if (binding.type !== "boolean" && fields.category === "mode" && ++modes > 1)
        throw new Error("Only one ACP mode selector is supported");
      if (typeof binding.current !== "function")
        throw new Error("ACP config requires a policy selector");
      if (binding.type === "boolean") {
        const patches = z
          .object({ true: PolicyPatchSchema, false: PolicyPatchSchema })
          .parse(structuredClone(binding.patches));
        return { ...fields, type: "boolean", current: binding.current, patches };
      }
      const options = binding.options.map((value) => choice.parse(structuredClone(value)));
      if (!options.length || new Set(options.map((value) => value.value)).size !== options.length)
        throw new Error("ACP config choices must be nonempty and unique");
      return { ...fields, current: binding.current, options };
    })
    .filter((binding) => binding.type !== "boolean" || booleanSupported);
}
export function configState(
  bindings: readonly AcpConfigBinding[],
  policy: Policy | undefined,
): { configOptions?: SessionConfigOption[]; modes?: SessionModeState } {
  if (!bindings.length) return {};
  if (!policy) throw new Error("ACP config requires journaled policy");
  const configOptions: SessionConfigOption[] = bindings.map((binding) => {
    const { id, name, description, category } = binding;
    const fields = {
      id,
      name,
      ...(description !== undefined ? { description } : {}),
      ...(category !== undefined ? { category } : {}),
    };
    if (binding.type === "boolean") {
      const currentValue = binding.current(policy);
      if (typeof currentValue !== "boolean")
        throw new Error(`ACP config ${id} requires a boolean policy value`);
      return { ...fields, type: "boolean", currentValue };
    }
    const currentValue = binding.current(policy);
    if (!binding.options.some((option) => option.value === currentValue))
      throw new Error(`Stored policy is not represented by ACP config ${id}`);
    return {
      ...fields,
      type: "select",
      currentValue,
      options: binding.options.map(({ patch: _, ...option }) => option),
    };
  });
  const mode = configOptions.find(
    (option) => option.category === "mode" && option.type === "select",
  );
  const modeBinding = bindings.find(
    (binding): binding is AcpSelectBinding =>
      binding.category === "mode" && binding.type !== "boolean",
  );
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

export function configPatch(
  binding: AcpConfigBinding,
  value: unknown,
  type?: string,
): PolicyPatch | undefined {
  if (binding.type === "boolean")
    return type === "boolean" && typeof value === "boolean"
      ? binding.patches[value ? "true" : "false"]
      : undefined;
  if (type !== undefined && type !== "select") return undefined;
  return binding.options.find((option) => option.value === value)?.patch;
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
