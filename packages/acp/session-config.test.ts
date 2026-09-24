import { builtinResolvers, initialPolicy, patchPolicy } from "@labkit-agent/core/policy";
import { expect, test } from "@logtape/testing-bun/autoload";

import { bindConfig, configPatch, configState, type AcpSelectBinding } from "./session-config.ts";

const capabilities = { agents: [["reviewer", { tools: [] }]] as const };

test("grouped choices retain protocol metadata, flatten only for legacy modes, and commit the chosen policy", () => {
  const binding: AcpSelectBinding = {
    id: "access",
    name: "Access",
    category: "mode",
    _meta: { application: "workspace" },
    current: (policy) => policy.permissions ?? "off",
    options: [
      {
        group: "supervised",
        name: "Supervised",
        _meta: { priority: 1 },
        options: [
          {
            value: "ask",
            name: "Ask",
            _meta: { recommended: true },
            patch: { permissions: "ask" },
          },
        ],
      },
      {
        group: "unattended",
        name: "Unattended",
        options: [{ value: "off", name: "Allow enabled tools", patch: { permissions: "off" } }],
      },
    ],
  };
  const [bound] = bindConfig([binding]);
  if (!bound) throw new Error("Missing binding");
  const policy = initialPolicy(capabilities, 4, { permissions: "off" });
  const state = configState([bound], policy);
  expect(state.configOptions?.[0]).toMatchObject({
    currentValue: "off",
    _meta: { application: "workspace" },
    options: [
      {
        group: "supervised",
        _meta: { priority: 1 },
        options: [{ value: "ask", _meta: { recommended: true } }],
      },
      { group: "unattended" },
    ],
  });
  expect(JSON.stringify(state)).not.toContain('"patch"');
  expect(state.modes?.availableModes.map((mode) => mode.id)).toEqual(["ask", "off"]);
  const patch = configPatch(bound, "ask");
  expect(patch).toEqual({ permissions: "ask" });
  const committed = patchPolicy(policy, patch!, capabilities, {
    ...builtinResolvers,
    permissionRequests: true,
  });
  expect(configState([bound], committed).configOptions?.[0]?.currentValue).toBe("ask");
  expect(configPatch(bound, "missing")).toBeUndefined();
  expect(configPatch(bound, false, "boolean")).toBeUndefined();
});

test("multiple mode categories preserve order and the first supplies the legacy mode alias", () => {
  const bindings = bindConfig(
    ["first", "second"].map((id) => ({
      id,
      name: id,
      category: "mode",
      current: () => "off",
      options: [{ value: "off", name: id, patch: { permissions: "off" as const } }],
    })),
  );
  const state = configState(bindings, initialPolicy(capabilities, 4));
  expect(state.configOptions?.map((option) => option.id)).toEqual(["first", "second"]);
  expect(state.modes?.availableModes[0]?.name).toBe("first");
});

test("mixed groups, duplicate groups and cross-group values are rejected", () => {
  const option = { value: "off", name: "Off", patch: { permissions: "off" as const } };
  const group = { group: "access", name: "Access", options: [option] };
  for (const options of [
    [option, group],
    [group, group],
    [group, { ...group, group: "other" }],
  ])
    expect(() =>
      bindConfig([{ id: "mode", name: "Mode", current: () => "off", options } as AcpSelectBinding]),
    ).toThrow();
});
