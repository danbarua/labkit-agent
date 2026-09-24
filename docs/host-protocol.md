# Why ACP sits outside the runtime

An editor needs to submit work, display progress, ask permission, and reopen history. Those needs
should not require it to implement the model/tool loop or understand journal records. ACP provides
the client protocol; the adapter translates it into core's public session contract.

Use the [ACP integration guide](../packages/acp/README.md) for setup and the
[protocol reference](../packages/acp/protocol-reference.md) for supported messages and limits.
This document explains the architectural boundary, not a roadmap or conformance claim.

## Translate known facts instead of reconstructing them

The runtime knows which operation failed and why. The adapter should translate that typed outcome
into an ACP stop reason or error. Searching journals for a refusal, matching tools by their names,
or keeping a second operation registry would hide a missing lower-level contract and create another
source of truth. Extend the public outcome when a fact is missing.

A core operation ID identifies a live tool card or terminal association. A provider call ID alone
is insufficient because it can recur in another turn. ACP request IDs are connection-local; include
the connection ID when joining diagnostics across clients or reconnects.

## Separate decisions from display

Permission replies determine whether a call may run. Tool cards, stream chunks, and plans describe
work but do not authorize it. This is why permission is an awaited, validated port while display
subscribers are best effort. A slow UI must not stall execution, but an unanswered permission
request must block its batch.

The adapter also cannot infer durability from a completed card. Individual tool results pass the
session receipt gate before the batch can use them. Only committed policy should determine a
configuration selector's current value. A client-visible progress update may precede those receipts.

## Recreate resources without replaying actions

A reconnected client needs history and fresh connections, not another invocation of every saved
tool. Restore reconstructs domain state and closes interrupted work. The adapter can reconnect MCP,
render committed results, and bind new permission callbacks without reissuing old calls.

Terminal handles, callbacks, and client connection IDs therefore stay outside the journal. Persist
an ordinary tool result when its content belongs in conversation history; do not persist a handle
with the expectation that it will still name a resource after restart.

## Keep environment authority explicit

The application factory chooses credentials, persistence, workspace roots, and exposed tools.
ACP transport does not create an OS sandbox. A delegated filesystem request follows client/editor
semantics, and a terminal command may access resources outside its cwd. Approval is consent to an
operation, not rollback protection or process confinement.

The stdio launcher reserves stdout for protocol traffic and supplies bounded durable diagnostics.
Embedded hosts must provide equivalent logging themselves. See
[operational retrieval](vscode-acp.md#runtime-diagnostics) and the
[session boundary diagrams](session-runtime.md) when diagnosing a failed request.
