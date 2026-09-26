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

export type AcpSelectOptions = readonly AcpSelectOption[] | readonly AcpSelectGroup[];

export type AcpSelectBinding = ConfigMetadata &
  Readonly<{
    type?: "select";
    current: (policy: Policy) => string;
    /** Static choices, or choices derived from the policy in effect (for example the current model). */
    options: AcpSelectOptions | ((policy: Policy) => AcpSelectOptions);
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

function flatten(options: AcpSelectOptions): readonly AcpSelectOption[] {
  return options.flatMap((option) => ("group" in option ? [...option.options] : [option]));
}

function parseOptions(raw: unknown): AcpSelectOptions {
  const options = z
    .union([z.array(choice).min(1), z.array(group).min(1)])
    .parse(structuredClone(raw));
  const choices = flatten(options);
  if (new Set(choices.map((value) => value.value)).size !== choices.length)
    throw new Error("ACP config choices must be nonempty and unique across groups");
  const groups = options.filter((option) => "group" in option);
  if (new Set(groups.map((option) => option.group)).size !== groups.length)
    throw new Error("Duplicate ACP config group ID");
  return options;
}

/** Choices offered under `policy`; policy-derived options are validated on every resolution. */
export function selectOptions(binding: AcpSelectBinding, policy: Policy): AcpSelectOptions {
  return typeof binding.options === "function"
    ? parseOptions(binding.options(policy))
    : binding.options;
}

export function selectChoices(
  binding: AcpSelectBinding,
  policy: Policy,
): readonly AcpSelectOption[] {
  return flatten(selectOptions(binding, policy));
}

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
      const options =
        typeof binding.options === "function" ? binding.options : parseOptions(binding.options);
      return { ...fields, current: binding.current, options };
    })
    .filter((binding) => binding.type !== "boolean" || booleanSupported);
}

/** Present a saved value the live binding no longer offers, so reading config never fails. */
function savedChoice(value: string) {
  return {
    value,
    name: `${value} (saved)`,
    description: "Saved session value; not offered by the current configuration",
  };
}

function unlisted(choices: readonly AcpSelectOption[], value: string) {
  return !choices.some((option) => option.value === value);
}

/** Select values in effect that the live bindings do not list as choices. */
export function unlistedValues(
  bindings: readonly AcpConfigBinding[],
  policy: Policy | undefined,
): { configId: string; value: string }[] {
  if (!policy) return [];
  return bindings.flatMap((binding) => {
    if (binding.type === "boolean") return [];
    const value = binding.current(policy);
    return unlisted(selectChoices(binding, policy), value) ? [{ configId: binding.id, value }] : [];
  });
}

/** Config options and mode state projected to the client for one policy. */
export type ConfigState = { configOptions?: SessionConfigOption[]; modes?: SessionModeState };

export function configState(
  bindings: readonly AcpConfigBinding[],
  policy: Policy | undefined,
): ConfigState {
  if (!bindings.length) return {};
  if (!policy) throw new Error("ACP config requires journaled policy");
  const modeChoices = new Map<string, readonly AcpSelectOption[]>();
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
    const options = selectOptions(binding, policy);
    const choices = flatten(options);
    modeChoices.set(id, choices);
    const saved = unlisted(choices, currentValue) ? savedChoice(currentValue) : undefined;
    return {
      ...fields,
      type: "select",
      currentValue,
      options:
        options.length && "group" in options[0]!
          ? [
              ...(options as readonly AcpSelectGroup[]).map(({ options, ...group }) => ({
                ...structuredClone(group),
                options: options.map(({ patch: _, ...option }) => structuredClone(option)),
              })),
              ...(saved ? [{ group: "labkit-saved", name: "Saved value", options: [saved] }] : []),
            ]
          : [
              ...(options as readonly AcpSelectOption[]).map(({ patch: _, ...option }) =>
                structuredClone(option),
              ),
              ...(saved ? [saved] : []),
            ],
    };
  });
  const mode = configOptions.find(
    (option) => option.category === "mode" && option.type === "select",
  );
  const modeBinding = bindings.find(
    (binding): binding is AcpSelectBinding =>
      binding.category === "mode" && binding.type !== "boolean",
  );
  const currentModeId = mode ? String(mode.currentValue) : "";
  const modeOptions = modeBinding ? (modeChoices.get(modeBinding.id) ?? []) : [];
  return {
    configOptions,
    ...(mode && modeBinding
      ? {
          modes: {
            currentModeId,
            availableModes: [
              ...modeOptions,
              ...(unlisted(modeOptions, currentModeId) ? [savedChoice(currentModeId)] : []),
            ].map(({ value, name, description }) => ({
              id: value,
              name,
              ...(description ? { description } : {}),
            })),
          },
        }
      : {}),
  };
}

/** Patch for choosing `value`, resolved against the policy in effect when it is applied. */
export function configPatch(
  binding: AcpConfigBinding,
  value: unknown,
  policy: Policy,
  type?: string,
): PolicyPatch | undefined {
  if (binding.type === "boolean")
    return type === "boolean" && typeof value === "boolean"
      ? binding.patches[value ? "true" : "false"]
      : undefined;
  if (type !== undefined && type !== "select") return undefined;
  return selectChoices(binding, policy).find((option) => option.value === value)?.patch;
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
