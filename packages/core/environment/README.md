# Environment bindings

`Environment` supplies an `AsyncIterable<EnvEvent>` and a renderer. `startEnvironment` binds those
to a session; `runEnvironment` can use an already-created or restored session. Neither function
calls completion/tools, inspects turn phases or polls for idle.

The loop awaits admission only. Terminal and branch outcomes are delivered through each command
handle separately, so an event source can emit abort or barge-in while work is active. Render updates
include snapshots, receipts and settlements; branch settlements include the published child runtime.
Snapshot observation is outside domain decisions, with observer failures isolated from execution.

Source exhaustion or an explicit close event closes the owned session and settles outstanding
handles. A source intending to wait for an answer must remain open until it receives the corresponding
settlement. Persistence lifetime remains caller-owned. A UI may switch its binding to a published
child; it must not construct a second tool loop.

The existing web completion console is intentionally unchanged. Integrating it is a separate UI task.
