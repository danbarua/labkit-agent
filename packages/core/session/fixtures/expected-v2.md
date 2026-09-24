# policy-permissions-allowance: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"default@1","version":2,"steps":0,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":[],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Go"}
- assistant: {"role":"assistant","text":"Restricted"}

## Turn 2: exhausted (a)

Outcome: {"kind":"exhausted"}

- user: {"role":"user","text":"No allowance"}

# policy-permissions-allowance: restored

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"default@1","version":2,"steps":0,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":[],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Go"}
- assistant: {"role":"assistant","text":"Restricted"}

## Turn 2: exhausted (a)

Outcome: {"kind":"exhausted"}

- user: {"role":"user","text":"No allowance"}

---

# queue-user: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"queued@1","version":0,"steps":4,"admission":"queue-user","bargeIn":false,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"First"}
- assistant: {"role":"assistant","text":"First"}

## Turn 2: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Second"}
- assistant: {"role":"assistant","text":"Second"}

# queue-user: restored

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"queued@1","version":0,"steps":4,"admission":"queue-user","bargeIn":false,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"First"}
- assistant: {"role":"assistant","text":"First"}

## Turn 2: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Second"}
- assistant: {"role":"assistant","text":"Second"}

---

# queue-recovery: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"queued@1","version":0,"steps":4,"admission":"queue-user","bargeIn":false,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: [{"inputId":"00000000-0000-4000-8000-000000000004","text":"Queued"}]
Context: []

## Interrupted/active turn 1: awaiting_model

- user: {"role":"user","text":"First"}

# queue-recovery: restored

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"queued@1","version":0,"steps":4,"admission":"queue-user","bargeIn":false,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: failed (a)

Outcome: {"kind":"failed","error":{"message":"Interrupted session; external effects were not replayed"}}

- user: {"role":"user","text":"First"}
  Recovery: Interrupted session; external effects were not replayed

---

# tool-error-continue: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"tolerant@1","version":0,"steps":4,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"return-error-and-continue","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Go"}
- assistant: {"role":"assistant","text":"Work","calls":[{"id":"bad","name":"echo","args":{"text":"error:broken"}},{"id":"ok","name":"echo","args":{"text":"ok"}}]}
- tool: {"role":"tool","text":"{\"error\":\"broken\"}","callId":"bad"}
- tool: {"role":"tool","text":"ok","callId":"ok"}
- assistant: {"role":"assistant","text":"Recovered"}

# tool-error-continue: restored

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"tolerant@1","version":0,"steps":4,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"return-error-and-continue","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Go"}
- assistant: {"role":"assistant","text":"Work","calls":[{"id":"bad","name":"echo","args":{"text":"error:broken"}},{"id":"ok","name":"echo","args":{"text":"ok"}}]}
- tool: {"role":"tool","text":"{\"error\":\"broken\"}","callId":"bad"}
- tool: {"role":"tool","text":"ok","callId":"ok"}
- assistant: {"role":"assistant","text":"Recovered"}

---

# abort-tools-on-user: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"default@1","version":0,"steps":4,"admission":"abort-tools-on-user","bargeIn":true,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: aborted (a)

Outcome: {"kind":"aborted"}

- user: {"role":"user","text":"Old"}
- assistant: {"role":"assistant","text":"Work","calls":[{"id":"fast","name":"echo","args":{"text":"fast"}},{"id":"slow","name":"echo","args":{"text":"defer:slow"}}]}
- tool: {"role":"tool","text":"fast","callId":"fast"}

## Turn 2: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"New"}
- assistant: {"role":"assistant","text":"New turn"}

# abort-tools-on-user: restored

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"default@1","version":0,"steps":4,"admission":"abort-tools-on-user","bargeIn":true,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: aborted (a)

Outcome: {"kind":"aborted"}

- user: {"role":"user","text":"Old"}
- assistant: {"role":"assistant","text":"Work","calls":[{"id":"fast","name":"echo","args":{"text":"fast"}},{"id":"slow","name":"echo","args":{"text":"defer:slow"}}]}
- tool: {"role":"tool","text":"fast","callId":"fast"}

## Turn 2: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"New"}
- assistant: {"role":"assistant","text":"New turn"}

---

# context-policy-fork: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 1
System inputs: ["Shared instruction"]
Policy: {"id":"default@1","version":1,"steps":4,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"fail-turn","project":"context-only@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Earlier"}
- assistant: {"role":"assistant","text":"Ancestor"}

# context-policy-fork: child

# Session 00000000-0000-4000-8000-000000000008

Origin: {"kind":"compaction","parent":"00000000-0000-4000-8000-000000000001","sequence":2}
System version: 1
System inputs: ["Shared instruction"]
Policy: {"id":"default@1","version":1,"steps":4,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"fail-turn","project":"context-only@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: [{"role":"user","text":"Summary"}]

## Turn 1: completed (b)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Continue"}
- assistant: {"role":"assistant","text":"Delegate"}
- assistant: {"role":"assistant","text":"Child answer"}

# context-policy-fork: restored

# Session 00000000-0000-4000-8000-000000000008

Origin: {"kind":"compaction","parent":"00000000-0000-4000-8000-000000000001","sequence":2}
System version: 1
System inputs: ["Shared instruction"]
Policy: {"id":"default@1","version":1,"steps":4,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"fail-turn","project":"context-only@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: [{"role":"user","text":"Summary"}]

## Turn 1: completed (b)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Continue"}
- assistant: {"role":"assistant","text":"Delegate"}
- assistant: {"role":"assistant","text":"Child answer"}

---

# legacy-upgrade: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"strict@1","version":1,"steps":2,"admission":"reject-during-tools","bargeIn":false,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Before"}
- assistant: {"role":"assistant","text":"Legacy"}

## Turn 2: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"After"}
- assistant: {"role":"assistant","text":"Version two"}

# legacy-upgrade: restored

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"strict@1","version":1,"steps":2,"admission":"reject-during-tools","bargeIn":false,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Before"}
- assistant: {"role":"assistant","text":"Legacy"}

## Turn 2: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"After"}
- assistant: {"role":"assistant","text":"Version two"}

---

# lost-acknowledgement: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"default@1","version":0,"steps":4,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Go"}
- assistant: {"role":"assistant","text":"Once"}

# lost-acknowledgement: restored

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"default@1","version":0,"steps":4,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Go"}
- assistant: {"role":"assistant","text":"Once"}

---

# thinking-continuation-branches-switch: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"default@1","version":1,"provider":"google-generate@1","thinking":"off","maxOutputTokens":2048,"steps":4,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Think and use tools twice"}
- assistant: {"role":"assistant","text":"","calls":[{"id":"c0","name":"echo","args":{"text":"result-0"}}],"owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":2}}
- tool: {"role":"tool","text":"result-0","callId":"c0"}
- assistant: {"role":"assistant","text":"","calls":[{"id":"c1","name":"echo","args":{"text":"result-1"}}],"owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":5}}
- tool: {"role":"tool","text":"result-1","callId":"c1"}
- assistant: {"role":"assistant","text":"Done","owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":8}}

## Turn 2: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Switch provider"}
- assistant: {"role":"assistant","text":"Google answer"}

# thinking-continuation-branches-switch: restored

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"default@1","version":0,"provider":"anthropic-messages@2","thinking":"adaptive","maxOutputTokens":2048,"steps":4,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Think and use tools twice"}
- assistant: {"role":"assistant","text":"","calls":[{"id":"c0","name":"echo","args":{"text":"result-0"}}],"owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":2}}
- tool: {"role":"tool","text":"result-0","callId":"c0"}
- assistant: {"role":"assistant","text":"","calls":[{"id":"c1","name":"echo","args":{"text":"result-1"}}],"owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":5}}
- tool: {"role":"tool","text":"result-1","callId":"c1"}
- assistant: {"role":"assistant","text":"Done","owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":8}}

# thinking-continuation-branches-switch: fork

# Session 00000000-0000-4000-8000-000000000014

Origin: {"kind":"fork","parent":"00000000-0000-4000-8000-000000000001","sequence":2}
System version: 0
System inputs: []
Policy: {"id":"default@1","version":0,"provider":"anthropic-messages@2","thinking":"adaptive","maxOutputTokens":2048,"steps":4,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Think and use tools twice"}
- assistant: {"role":"assistant","text":"","calls":[{"id":"c0","name":"echo","args":{"text":"result-0"}}],"owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":2}}
- tool: {"role":"tool","text":"result-0","callId":"c0"}
- assistant: {"role":"assistant","text":"","calls":[{"id":"c1","name":"echo","args":{"text":"result-1"}}],"owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":5}}
- tool: {"role":"tool","text":"result-1","callId":"c1"}
- assistant: {"role":"assistant","text":"Done","owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":8}}

## Turn 2: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Continue inherited context"}
- assistant: {"role":"assistant","text":"Done","owner":{"turnId":"00000000-0000-4000-8000-000000000014/turn/2","generation":2}}

# thinking-continuation-branches-switch: compact

# Session 00000000-0000-4000-8000-000000000020

Origin: {"kind":"compaction","parent":"00000000-0000-4000-8000-000000000001","sequence":2}
System version: 0
System inputs: []
Policy: {"id":"default@1","version":0,"provider":"anthropic-messages@2","thinking":"adaptive","maxOutputTokens":2048,"steps":4,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Fresh context"}
- assistant: {"role":"assistant","text":"Done","owner":{"turnId":"00000000-0000-4000-8000-000000000020/turn/1","generation":2}}

---

# markdown-attachment-restore-fork-compact: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"default@1","version":0,"provider":"openai-chat@1","steps":4,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Review this","parts":[{"type":"text","text":"Review this"},{"type":"blob","ref":{"id":"b13b3392f0140b08d909e5d982bafba3bf4a188ae3ecd4db2d4116300126c833","media":"text/markdown","bytes":40,"name":"DESIGN.md"}}]}
- assistant: {"role":"assistant","text":"Reviewed"}

# markdown-attachment-restore-fork-compact: restored

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"default@1","version":0,"provider":"openai-chat@1","steps":4,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Review this","parts":[{"type":"text","text":"Review this"},{"type":"blob","ref":{"id":"b13b3392f0140b08d909e5d982bafba3bf4a188ae3ecd4db2d4116300126c833","media":"text/markdown","bytes":40,"name":"DESIGN.md"}}]}
- assistant: {"role":"assistant","text":"Reviewed"}

# markdown-attachment-restore-fork-compact: fork

# Session 00000000-0000-4000-8000-000000000006

Origin: {"kind":"fork","parent":"00000000-0000-4000-8000-000000000001","sequence":2}
System version: 0
System inputs: []
Policy: {"id":"default@1","version":0,"provider":"openai-chat@1","steps":4,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Review this","parts":[{"type":"text","text":"Review this"},{"type":"blob","ref":{"id":"b13b3392f0140b08d909e5d982bafba3bf4a188ae3ecd4db2d4116300126c833","media":"text/markdown","bytes":40,"name":"DESIGN.md"}}]}
- assistant: {"role":"assistant","text":"Reviewed"}

## Turn 2: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Review again"}
- assistant: {"role":"assistant","text":"Fork review"}

# markdown-attachment-restore-fork-compact: compact

# Session 00000000-0000-4000-8000-000000000012

Origin: {"kind":"compaction","parent":"00000000-0000-4000-8000-000000000001","sequence":2}
System version: 0
System inputs: []
Policy: {"id":"default@1","version":0,"provider":"openai-chat@1","steps":4,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: [{"role":"user","text":"","parts":[{"type":"blob","ref":{"id":"b13b3392f0140b08d909e5d982bafba3bf4a188ae3ecd4db2d4116300126c833","media":"text/markdown","bytes":40,"name":"DESIGN.md"}}]}]

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Review replacement context"}
- assistant: {"role":"assistant","text":"Compact review"}

---

# google-thinking-parallel-tools: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"default@1","version":0,"provider":"google-generate@2","thinking":"adaptive","steps":4,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Think and use tools twice"}
- assistant: {"role":"assistant","text":"work-0","calls":[{"id":"c0-0","name":"echo","args":{"text":"result-0-0"}},{"id":"c0-1","name":"echo","args":{"text":"result-0-1"}}],"owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":2}}
- tool: {"role":"tool","text":"result-0-0","callId":"c0-0"}
- tool: {"role":"tool","text":"result-0-1","callId":"c0-1"}
- assistant: {"role":"assistant","text":"work-1","calls":[{"id":"c1-0","name":"echo","args":{"text":"result-1-0"}},{"id":"c1-1","name":"echo","args":{"text":"result-1-1"}}],"owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":5}}
- tool: {"role":"tool","text":"result-1-0","callId":"c1-0"}
- tool: {"role":"tool","text":"result-1-1","callId":"c1-1"}
- assistant: {"role":"assistant","text":"Done","owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":8}}

# google-thinking-parallel-tools: restored

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"default@1","version":0,"provider":"google-generate@2","thinking":"adaptive","steps":4,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Think and use tools twice"}
- assistant: {"role":"assistant","text":"work-0","calls":[{"id":"c0-0","name":"echo","args":{"text":"result-0-0"}},{"id":"c0-1","name":"echo","args":{"text":"result-0-1"}}],"owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":2}}
- tool: {"role":"tool","text":"result-0-0","callId":"c0-0"}
- tool: {"role":"tool","text":"result-0-1","callId":"c0-1"}
- assistant: {"role":"assistant","text":"work-1","calls":[{"id":"c1-0","name":"echo","args":{"text":"result-1-0"}},{"id":"c1-1","name":"echo","args":{"text":"result-1-1"}}],"owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":5}}
- tool: {"role":"tool","text":"result-1-0","callId":"c1-0"}
- tool: {"role":"tool","text":"result-1-1","callId":"c1-1"}
- assistant: {"role":"assistant","text":"Done","owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":8}}

---

# responses-thinking-tools: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"default@1","version":0,"provider":"openai-responses@2","thinking":"high","steps":4,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Think and use tools twice"}
- assistant: {"role":"assistant","text":"","calls":[{"id":"c0","name":"echo","args":{"text":"result-0"}}],"owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":2}}
- tool: {"role":"tool","text":"result-0","callId":"c0"}
- assistant: {"role":"assistant","text":"","calls":[{"id":"c1","name":"echo","args":{"text":"result-1"}}],"owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":5}}
- tool: {"role":"tool","text":"result-1","callId":"c1"}
- assistant: {"role":"assistant","text":"Done","owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":8}}

# responses-thinking-tools: restored

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"default@1","version":0,"provider":"openai-responses@2","thinking":"high","steps":4,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Think and use tools twice"}
- assistant: {"role":"assistant","text":"","calls":[{"id":"c0","name":"echo","args":{"text":"result-0"}}],"owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":2}}
- tool: {"role":"tool","text":"result-0","callId":"c0"}
- assistant: {"role":"assistant","text":"","calls":[{"id":"c1","name":"echo","args":{"text":"result-1"}}],"owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":5}}
- tool: {"role":"tool","text":"result-1","callId":"c1"}
- assistant: {"role":"assistant","text":"Done","owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":8}}

---

# thinking-parity-provider-switch: root

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"default@1","version":2,"provider":"google-generate@2","thinking":"adaptive","steps":4,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"First"}
- assistant: {"role":"assistant","text":"Google answer","owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":2}}

## Turn 2: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Switch to Responses"}
- assistant: {"role":"assistant","text":"Responses answer","owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/2","generation":2}}

## Turn 3: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Switch back to Google"}
- assistant: {"role":"assistant","text":"Google again","owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/3","generation":2}}

# thinking-parity-provider-switch: restored

# Session 00000000-0000-4000-8000-000000000001

Origin: {"kind":"root"}
System version: 0
System inputs: []
Policy: {"id":"default@1","version":2,"provider":"google-generate@2","thinking":"adaptive","steps":4,"admission":"reject-during-tools","bargeIn":true,"toolFailure":"fail-turn","project":"history@1","handoff":"handoff-slim@1","tools":{"a":["echo"],"b":["echo"]}}
Pending inputs: []
Context: []

## Turn 1: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"First"}
- assistant: {"role":"assistant","text":"Google answer","owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/1","generation":2}}

## Turn 2: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Switch to Responses"}
- assistant: {"role":"assistant","text":"Responses answer","owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/2","generation":2}}

## Turn 3: completed (a)

Outcome: {"kind":"completed"}

- user: {"role":"user","text":"Switch back to Google"}
- assistant: {"role":"assistant","text":"Google again","owner":{"turnId":"00000000-0000-4000-8000-000000000001/turn/3","generation":2}}
