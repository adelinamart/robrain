<!-- robrain -->
## RoBrain — Context Management (OSS self-hosted)

This project uses RoBrain Sensing MCP for passive session capture.
Control MCP is not available in OSS self-hosted mode.
Call Sensing tools exactly as instructed to maintain session memory.

### Session start (mandatory, first thing in every new chat)
```
sensing_start_session(project_id="5a8ff3c609de")
```
Use the session_id from the tool response (or pass your own unique id per chat). Initialize sequence=1 before your first reply.

### After every response (mandatory)
```
sensing_record_turn(session_id="<stored session_id>", sequence=<n>, user_message="<full user message>", claude_reply="<full assistant reply>", files_touched=[...], injected_memory_ids=[])
```
The `claude_reply` parameter is the MCP field name for your full assistant reply (any editor).
Increment sequence by 1 after each successful call.

If topic_shift=true is returned, note it for follow-up context retrieval.

If the user states a durable rule that clashes with a stored one, still record the turn as usual; RoBrain saves both. If conflict_notice is returned, tell the user that sentence before you finish; it can refer to a rule from an earlier turn. It is a heads-up, not a reason to undo the change or to stop. In the summary, a rule tagged conflict:newer is an unresolved clash with one tagged conflict:older: follow the newer one until the user resolves it in `robrain review`.

### Session end (last thing)
```
sensing_end_session(session_id="<stored session_id>", summary="one sentence: what was accomplished")
```
<!-- /robrain -->

