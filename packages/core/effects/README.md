# Effects

An effect is an interaction the runtime had with the outside world, or the lifecycle of an
operation boundary: a child operation, a tool call, a permission question, a provider HTTP request
or stream. Effects are emitted only at operation boundaries — [`host/context.ts`](../host/context.ts)
and [`host/host.ts`](../host/host.ts) (child lifecycle, command dispatch), `host/commands/*` (tool
admission and run, permission decisions, completion usage), and
[`providers/transport.ts`](../providers/transport.ts) / [`providers/stream.ts`](../providers/stream.ts)
(the provider HTTP request/response and stream lifecycle around fetch). Pure decisions and the
journal fold never emit; the fold also runs on load, where nothing happens.

## Wire a subscriber

`EffectEmitter` is `(event: EffectEvent) => void`. Supply one through `ExecutionBindings.effects`
for host-level events, and `TransportBinding.effects` on each provider binding for transport-level
events. Both are additive: the runtime always combines your subscriber with the default
`diagnosticsSubscriber()` through `fanoutEffects`, so binding one never silences logging, and a
throwing subscriber never affects execution or the other subscribers.

```ts
import type { EffectEmitter } from "@labkit-agent/core/effects";

const usage: EffectEmitter = (event) => {
  if (event.type === "completion.usage.received") recordUsage(event.fields.usage);
};
```

`event.fields` carries the same structured bag `diagnostic()` accepts, including whatever
correlation IDs are known at that boundary (`sessionId`, `turnId`, `childId`, `toolCallId`,
`httpRequestId`). `event.type` narrows to the runtime's known event names but also accepts any
other string, so a later core module or an environment can introduce a new effect name without
widening the exported union.

## Logging is a subscriber

`diagnosticsSubscriber()` is the default: it reproduces exactly the `diagnostic(category, level,
event, fields)` record the event names above have always produced. It is not a second emission
path; every `diagnostic()` call this runtime makes today is one of these events reaching that
subscriber. `completion.system_prompt` is emitted at `debug` (previously `info`); every other
event's category, level and fields are unchanged.

## Side-car HTTP trace

Full request/response bodies are not part of `EffectEvent`; a subscriber that needs raw traffic
subscribes to `TransportBinding.capture` instead (see
[the environment README](../environment/README.md#retained-provider-traffic)). That keeps
`EffectEvent` cheap to construct at every boundary and keeps credential-bearing bodies out of the
general subscriber API.
