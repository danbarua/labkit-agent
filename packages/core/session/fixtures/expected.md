# plain-conversation: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Hi"}
- assistant: {"role":"assistant","text":"Hello"}

## Turn 2: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Continue"}
- assistant: {"role":"assistant","text":"Again"}

# plain-conversation: restored

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Hi"}
- assistant: {"role":"assistant","text":"Hello"}

## Turn 2: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Continue"}
- assistant: {"role":"assistant","text":"Again"}

---

# system-changes: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 1
System inputs: ["First","Second"]
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Hi"}
- assistant: {"role":"assistant","text":"Brief"}

# system-changes: restored

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 1
System inputs: ["First","Second"]
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Hi"}
- assistant: {"role":"assistant","text":"Brief"}

---

# tools: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Run tools"}
- assistant: {"role":"assistant","text":"Checking","calls":[{"id":"c1","name":"echo","args":{"text":"one"}},{"id":"c2","name":"echo","args":{"text":"two"}}]}
- tool: {"role":"tool","text":"one","callId":"c1"}
- tool: {"role":"tool","text":"two","callId":"c2"}
- assistant: {"role":"assistant","text":"Checked"}

---

# partial-cancellation-late-result: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

## Turn 1: aborted (a)

Outcome: {"kind":"aborted"}

- user: {"role":"user","text":"Go"}
- assistant: {"role":"assistant","text":"Working","calls":[{"id":"fast","name":"echo","args":{"text":"fast"}},{"id":"slow","name":"echo","args":{"text":"defer:slow"}}]}
- tool: {"role":"tool","text":"fast","callId":"fast"}

# partial-cancellation-late-result: restored

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

## Turn 1: aborted (a)

Outcome: {"kind":"aborted"}

- user: {"role":"user","text":"Go"}
- assistant: {"role":"assistant","text":"Working","calls":[{"id":"fast","name":"echo","args":{"text":"fast"}},{"id":"slow","name":"echo","args":{"text":"defer:slow"}}]}
- tool: {"role":"tool","text":"fast","callId":"fast"}

---

# fork: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"First"}
- assistant: {"role":"assistant","text":"Shared"}

# fork: child

# Session 00000000-0000-4000-8000-000000000006

Origin: {"kind":"fork","parent":"00000000-0000-4000-8000-000000000001","sequence":2}
System version: 1
System inputs: ["Independent"]
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"First"}
- assistant: {"role":"assistant","text":"Shared"}

## Turn 2: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Branch"}
- assistant: {"role":"assistant","text":"Child"}

# fork: restored

# Session 00000000-0000-4000-8000-000000000006

Origin: {"kind":"fork","parent":"00000000-0000-4000-8000-000000000001","sequence":2}
System version: 1
System inputs: ["Independent"]
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"First"}
- assistant: {"role":"assistant","text":"Shared"}

## Turn 2: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Branch"}
- assistant: {"role":"assistant","text":"Child"}

---

# active-turn-fork: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"First"}
- assistant: {"role":"assistant","text":"Boundary"}

## Turn 2: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Next"}
- assistant: {"role":"assistant","text":"Parent next"}

# active-turn-fork: child

# Session 00000000-0000-4000-8000-000000000005

Origin: {"kind":"fork","parent":"00000000-0000-4000-8000-000000000001","sequence":2}
System version: 0
System inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"First"}
- assistant: {"role":"assistant","text":"Boundary"}

---

# successive-compaction-empty-reset: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Original"}
- assistant: {"role":"assistant","text":"Source"}

# successive-compaction-empty-reset: compact1

# Session 00000000-0000-4000-8000-000000000006

Origin: {"kind":"compaction","parent":"00000000-0000-4000-8000-000000000001","sequence":2}
System version: 0
System inputs: []
Context: [{"role":"user","text":"Summary one"}]

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"More"}
- assistant: {"role":"assistant","text":"After compaction"}

# successive-compaction-empty-reset: compact2

# Session 00000000-0000-4000-8000-000000000012

Origin: {"kind":"compaction","parent":"00000000-0000-4000-8000-000000000006","sequence":2}
System version: 0
System inputs: []
Context: [{"role":"user","text":"Summary two"}]

# successive-compaction-empty-reset: reset

# Session 00000000-0000-4000-8000-000000000015

Origin: {"kind":"compaction","parent":"00000000-0000-4000-8000-000000000012","sequence":1}
System version: 0
System inputs: []
Context: []

# successive-compaction-empty-reset: restored

# Session 00000000-0000-4000-8000-000000000015

Origin: {"kind":"compaction","parent":"00000000-0000-4000-8000-000000000012","sequence":1}
System version: 0
System inputs: []
Context: []

---

# handoff: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 1
System inputs: ["Shared instruction"]
Context: []

## Turn 1: completed (b)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Help"}
- assistant: {"role":"assistant","text":"Delegate"}
- assistant: {"role":"assistant","text":"From B"}

# handoff: restored

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 1
System inputs: ["Shared instruction"]
Context: []

## Turn 1: completed (b)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Help"}
- assistant: {"role":"assistant","text":"Delegate"}
- assistant: {"role":"assistant","text":"From B"}

---

# exhaustion: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

## Turn 1: exhausted (b)

Outcome: {"kind":"exhausted"}

- user: {"role":"user","text":"Help"}
- assistant: {"role":"assistant","text":"Delegate"}

---

# failure: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

## Turn 1: failed (a)

Outcome: {"kind":"failed","error":{"message":"Scripted transport failure"}}

- user: {"role":"user","text":"Help"}

# failure: restored

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

## Turn 1: failed (a)

Outcome: {"kind":"failed","error":{"message":"Scripted transport failure"}}

- user: {"role":"user","text":"Help"}

---

# invalid-context: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

---

# interrupted-recovery: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

## Interrupted/active turn 1: executing_tools

- user: {"role":"user","text":"Go"}
- assistant: {"role":"assistant","text":"Working","calls":[{"id":"fast","name":"echo","args":{"text":"fast"}},{"id":"slow","name":"echo","args":{"text":"defer:slow"}}]}
- Committed tool outcome: {"kind":"tool","turnId":"00000000-0000-4000-8000-000000000001/turn/1","batchId":"00000000-0000-4000-8000-000000000001/turn/1/3","callId":"fast","result":{"kind":"succeeded","value":"fast"}}

# interrupted-recovery: restored

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

## Turn 1: failed (a)

Outcome: {"kind":"failed","error":{"message":"Interrupted session; external effects were not replayed"}}

- user: {"role":"user","text":"Go"}
- assistant: {"role":"assistant","text":"Working","calls":[{"id":"fast","name":"echo","args":{"text":"fast"}},{"id":"slow","name":"echo","args":{"text":"defer:slow"}}]}
- tool: {"role":"tool","text":"fast","callId":"fast"}
  Recovery: Interrupted session; external effects were not replayed

# interrupted-recovery: twice

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

## Turn 1: failed (a)

Outcome: {"kind":"failed","error":{"message":"Interrupted session; external effects were not replayed"}}

- user: {"role":"user","text":"Go"}
- assistant: {"role":"assistant","text":"Working","calls":[{"id":"fast","name":"echo","args":{"text":"fast"}},{"id":"slow","name":"echo","args":{"text":"defer:slow"}}]}
- tool: {"role":"tool","text":"fast","callId":"fast"}
  Recovery: Interrupted session; external effects were not replayed

---

# interrupted-completion: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

## Interrupted/active turn 1: awaiting_model

- user: {"role":"user","text":"Go"}

# interrupted-completion: restored

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

## Turn 1: failed (a)

Outcome: {"kind":"failed","error":{"message":"Interrupted session; external effects were not replayed"}}

- user: {"role":"user","text":"Go"}
  Recovery: Interrupted session; external effects were not replayed

---

# rejected-append: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

---

# lost-acknowledgement: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Go"}
- assistant: {"role":"assistant","text":"Only once"}

# lost-acknowledgement: restored

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Go"}
- assistant: {"role":"assistant","text":"Only once"}

---

# lost-recovery-acknowledgement: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

## Interrupted/active turn 1: awaiting_model

- user: {"role":"user","text":"Go"}

# lost-recovery-acknowledgement: restored

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

## Turn 1: failed (a)

Outcome: {"kind":"failed","error":{"message":"Interrupted session; external effects were not replayed"}}

- user: {"role":"user","text":"Go"}
  Recovery: Interrupted session; external effects were not replayed

---

# barge-in: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"First"}
- user: {"role":"user","text":"Second"}
- assistant: {"role":"assistant","text":"New"}
