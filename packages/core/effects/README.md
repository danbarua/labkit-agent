# Effects

An effect is an interaction the runtime had with the outside world, or the lifecycle of an
operation boundary: a child operation, a tool call, a permission question, a provider HTTP request
or stream. Effects are emitted only at operation boundaries — [`host/context.ts`](../host/context.ts)
and [`host/host.ts`](../host/host.ts) (child lifecycle, command dispatch), `host/commands/*` (tool
admission and run, permission decisions, completion usage), and
[`providers/transport.ts`](../providers/transport.ts) / [`providers/stream.ts`](../providers/stream.ts)
(the provider HTTP request/response and stream lifecycle around fetch). Pure decisions and the
journal fold never emit; the fold also runs on load, where nothing happens.

## `EffectEvent` is a closed, typed union

`EffectEvent` is a discriminated union keyed by `type`: one member per event this runtime can
raise, each with its own typed payload (correlation IDs plus that event's actual domain data, for
example `usage: CompletionUsage` on `completion.usage.received`). There is no generic fields bag
and no open string escape hatch: narrowing on `type` gives typed fields directly, without a cast.

Category and level are not part of the payload. They are a logging decision, made once by
`resolveDiagnostic`'s internal table, keyed by `type` and checked by the compiler: the table's type
requires every member of `EffectEvent["type"]`, so adding a union member without a table entry is a
compile error, never a silent fallback.

## Wire a subscriber

`EffectEmitter` is `(event: EffectEvent) => unknown`. Supply one through
`SessionBindings.effects`/`ExecutionBindings.effects` for host-level events, and
`TransportBinding.effects` on each provider binding for transport-level events. Both are additive:
the runtime always combines your subscriber with the default `diagnosticsSubscriber()` through
`fanoutEffects`, so binding one never silences logging. A subscriber's failure never affects
execution or the other subscribers: `fanoutEffects` catches a synchronous throw and attaches a
rejection handler to an async subscriber's returned promise, so neither crashes the process or
blocks the rest.

```ts
import type { EffectEmitter } from "@labkit-agent/core/effects";

const usage: EffectEmitter = (event) => {
  if (event.type === "completion.usage.received") recordUsage(event.usage); // typed, no cast
};
```

## Logging is a subscriber

`diagnosticsSubscriber()` is the default: it reproduces exactly the `diagnostic(category, level,
event, fields)` record the event names above have always produced, via `resolveDiagnostic`. It is
not a second emission path for these events. Session lifecycle, journal append/load and ACP adapter
logs are not effect events yet: they still call `diagnostic()` directly. `completion.system_prompt` is emitted at `debug` (previously
`info`); every other event's category, level and fields are unchanged.

## Side-car HTTP trace

Full request/response bodies are not part of `EffectEvent`; a subscriber that needs raw traffic
subscribes to `TransportBinding.capture` instead (see
[the environment README](../environment/README.md#retained-provider-traffic)). That keeps
`EffectEvent` a closed set of small, typed payloads and keeps credential-bearing bodies out of the
general subscriber API.
