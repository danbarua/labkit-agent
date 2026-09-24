import type { SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk";
import { PolicyPatchSchema, type Policy, type PolicyPatch } from "@labkit-agent/core/policy";
import { z } from "zod";

type ConfigMetadata = Readonly<{
  id: string;
  name: string;
  description?: string;
  category?: string;
  _meta?: Record<string, unknown>;
}>;
export type AcpSelectOption = Readonly<{
  value: string;
  name: string;
  description?: string;
  _meta?: Record<string, unknown>;
  patch: PolicyPatch;
}>;

export type AcpSelectGroup = Readonly<{
  group: string;
  name: string;
  _meta?: Record<string, unknown>;
  options: readonly AcpSelectOption[];
}>;

export type AcpSelectBinding = ConfigMetadata &
  Readonly<{
    type?: "select";
    current: (policy: Policy) => string;
    options: readonly AcpSelectOption[] | readonly AcpSelectGroup[];
  }>;

export function selectChoices(binding: AcpSelectBinding): readonly AcpSelectOption[] {
  return binding.options.flatMap((option) => ("group" in option ? [...option.options] : [option]));
}

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
  _meta: z.record(z.string(), z.json()).optional(),
});
const choice = z.object({
  value: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  _meta: z.record(z.string(), z.json()).optional(),
  patch: PolicyPatchSchema,
});
const group = z.object({
  group: z.string().min(1),
  name: z.string().min(1),
  _meta: z.record(z.string(), z.json()).optional(),
  options: z.array(choice).min(1),
});

export function bindConfig(
  bindings: readonly AcpConfigBinding[] = [],
  booleanSupported = false,
): readonly AcpConfigBinding[] {
  const ids = new Set<string>();
  return bindings
    .map((binding): AcpConfigBinding => {
      const fields = structuredClone(metadata.parse(binding));
      if (ids.has(fields.id)) throw new Error("Duplicate ACP config ID");
      ids.add(fields.id);
      if (typeof binding.current !== "function")
        throw new Error("ACP config requires a policy selector");
      if (binding.type === "boolean") {
        const patches = z
          .object({ true: PolicyPatchSchema, false: PolicyPatchSchema })
          .parse(structuredClone(binding.patches));
        return { ...fields, type: "boolean", current: binding.current, patches };
      }
      const options = z
        .union([z.array(choice).min(1), z.array(group).min(1)])
        .parse(structuredClone(binding.options));
      const choices = selectChoices({ ...fields, current: binding.current, options });
      if (new Set(choices.map((value) => value.value)).size !== choices.length)
        throw new Error("ACP config choices must be nonempty and unique across groups");
      const groups = options.filter((option) => "group" in option);
      if (new Set(groups.map((option) => option.group)).size !== groups.length)
        throw new Error("Duplicate ACP config group ID");
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
    const { id, name, description, category, _meta } = binding;
    const fields = {
      id,
      name,
      ...(_meta !== undefined ? { _meta: structuredClone(_meta) } : {}),
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
    if (!selectChoices(binding).some((option) => option.value === currentValue))
      throw new Error(`Stored policy is not represented by ACP config ${id}`);
    return {
      ...fields,
      type: "select",
      currentValue,
      options:
        binding.options.length && "group" in binding.options[0]!
          ? (binding.options as readonly AcpSelectGroup[]).map(({ options, ...group }) => ({
              ...structuredClone(group),
              options: options.map(({ patch: _, ...option }) => structuredClone(option)),
            }))
          : (binding.options as readonly AcpSelectOption[]).map(({ patch: _, ...option }) =>
              structuredClone(option),
            ),
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
            availableModes: selectChoices(modeBinding).map(({ value, name, description }) => ({
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
  return selectChoices(binding).find((option) => option.value === value)?.patch;
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
