import { expect, test } from "bun:test";

import { bindAuth } from "./auth.ts";

const signal = () => new AbortController().signal;
test("auth methods are copied and terminal methods require the client's auth capability", () => {
  const methods = [
    { id: "login", name: "Login" },
    { type: "terminal" as const, id: "terminal", name: "Interactive login", args: ["--login"] },
  ];
  const auth = bindAuth({ methods, isAuthenticated: () => false, authenticate: () => {} });
  methods[0]!.name = "mutated";
  expect(auth.methods({})).toEqual([{ id: "login", name: "Login" }]);
  expect(auth.methods({ auth: { terminal: true } })).toHaveLength(2);
  const exposed = auth.methods({});
  exposed[0]!.name = "changed";
  expect(auth.methods({})[0]!.name).toBe("Login");
  expect(() => auth.authenticate("terminal", signal(), async () => {})).toThrow(
    "agent authentication",
  );
});

test("auth rejects invalid bindings and does not treat a successful callback as credentials", async () => {
  expect(() =>
    bindAuth({ methods: [{ id: "login", name: "Login" }], isAuthenticated: () => false }),
  ).toThrow("callback");
  expect(() =>
    bindAuth({
      methods: [
        { id: "same", name: "A" },
        { id: "same", name: "B" },
      ],
      isAuthenticated: () => false,
      authenticate: () => {},
    }),
  ).toThrow("unique");
  const auth = bindAuth({
    methods: [{ id: "login", name: "Login" }],
    isAuthenticated: () => false,
    authenticate: () => {},
  });
  await expect(auth.authenticate("login", signal(), async () => {})).rejects.toThrow();
  expect(() => auth.requireAccess()).toThrow();
  const none = bindAuth();
  expect(() => none.requireAccess()).not.toThrow();
  expect(none.methods({})).toEqual([]);
  expect(none.logoutSupported).toBe(false);
});

test("failed logout leaves access denied until a successful new login", async () => {
  let available = true;
  let broken = true;
  const auth = bindAuth({
    methods: [{ id: "login", name: "Login" }],
    isAuthenticated: () => available,
    authenticate: () => {
      available = true;
    },
    logout: () => {
      if (broken) throw new Error("store unavailable");
      available = false;
    },
  });
  expect(() => auth.requireAccess()).not.toThrow();
  await expect(auth.logout(signal(), async () => {})).rejects.toThrow("store unavailable");
  expect(() => auth.requireAccess()).toThrow();
  await auth.authenticate("login", signal(), async () => {});
  expect(() => auth.requireAccess()).not.toThrow();
  broken = false;
  await auth.logout(signal(), async () => {});
  expect(() => auth.requireAccess()).toThrow();
});
