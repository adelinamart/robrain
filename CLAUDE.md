<!-- robrain -->
## RoBrain — Context Management

This project uses RoBrain for persistent institutional memory across sessions.
Call these tools as instructed to maintain causal memory of decisions.

### Session start (mandatory)
Before your first reply in each new chat, call:
sensing_start_session(project_id="846e5e429167", session_id="<ISO-timestamp>-<4-random-chars>", working_dir="<cwd>")
Store session_id and set sequence=1.


### After every response (mandatory)
Call:
sensing_record_turn(
  session_id="<stored session_id>",
  sequence=<current sequence>,
  user_message="<full user message>",
  claude_reply="<your full reply>",
  files_touched=[...],
  injected_memory_ids=[]
)
Then increment sequence by 1.

```
If topic_shift=true is returned, immediately call:
```
control_inject_context(project_id="846e5e429167", session_id=..., task_description=..., files_in_scope=[...])
```

### When you need deeper context
```
control_get_context(project_id="846e5e429167", session_id=..., query=..., files_relevant=[...])
```

### When prior context is wrong or outdated
```
control_record_correction(session_id=..., decision_id=..., source="user_correction"|"claude_disagreement", invalidate=true)
```

### When user adds a rule
```
control_add_rule(project_id="846e5e429167", rule="...", type="always_include"|"always_exclude"|"preference")
```

### Session end (last thing)
```
sensing_end_session(session_id=..., summary="one sentence: what was accomplished")
control_end_session(project_id="846e5e429167", session_id=...)
```

### Acknowledgement rule
When injected context contains a question marked ⚠, you must explicitly state
whether the constraint applies to the current task before proceeding.
<!-- /robrain -->
