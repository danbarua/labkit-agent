# @labkit-agent/core

Internal, Bun-first package for durable agent sessions. The package exports TypeScript source;
Bun runs it directly and TypeScript consumes its types without a build step. It depends only on
Zod and LogTape. Attachment hashing uses Bun APIs, so Node/browser execution is not supported by
this package contract. `private: true` prevents accidental registry publication; local links and
packed tarballs still work.

## Live local development

Register this checkout once:

```sh
cd /Users/dan/Code/science/labkit-agent/packages/core
bun link
```

From a sibling project:

```sh
bun link --save @labkit-agent/core
```

This records `"@labkit-agent/core": "link:@labkit-agent/core"` in the consumer's dependencies.
Source edits are available immediately; restart the consumer process to load them. Other machines
must register their own checkout. Keep the source checkout's dependencies installed with
`bun install` from the repository root.

## Fixed local snapshot

To dogfood a particular snapshot independently of subsequent source edits:

```sh
cd /Users/dan/Code/science/labkit-agent/packages/core
bun pm pack --destination /tmp
# In the consumer project:
bun add /tmp/labkit-agent-core-0.1.0.tgz
```

The archive includes runtime sources and module documentation, excluding tests, fixture runners,
and fixture baselines. Only the process-local memory persistence adapter is exported under
`/testing`; it is not durable storage. Copy the archive somewhere persistent before relying on it
for repeat installations. No registry server or registry publication is required.

## Usage

```ts
import { createSession } from "@labkit-agent/core";
import { createMemoryPersistence } from "@labkit-agent/core/testing";

const session = await createSession({
  persistence: createMemoryPersistence(),
  configuration: {
    agent: "assistant",
    agents: new Map([["assistant", { model: "test-model" }]]),
    steps: 4,
  },
  bindings: {
    complete: () => ({ kind: "answer", text: "Hello from core" }),
  },
});
const result = await session.input("Hello").settled;
console.log(result);
await session.close();
```

The root export is the session API. Explicit subpaths provide `/session`, `/agent` (nonjournaled
runtime), `/types`, `/content`, `/host`, `/providers`, `/policy`, `/environment`, `/logging`, `/fsm`,
and `/testing`. Internal deep imports are not exported. Consumers using TypeScript should use
`moduleResolution: "bundler"`, `noEmit: true`, and Bun types (`bun add --dev @types/bun`).
See each module's README for runtime, persistence, provider and permission contracts.
