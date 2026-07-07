<!-- robrain -->
## RoBrain — Context Management (OSS self-hosted)

This project uses RoBrain Sensing MCP for passive session capture.
Control MCP is not available in OSS self-hosted mode.
Call Sensing tools exactly as instructed to maintain session memory.

### Session start (mandatory, first thing in every new chat)
```
sensing_start_session(project_id="5a8ff3c609de", working_dir="<cwd>")
```
Use the session_id from the tool response (or pass your own unique id per chat). Initialize sequence=1 before your first reply.

### After every response (mandatory)
```
sensing_record_turn(session_id="<stored session_id>", sequence=<n>, user_message="<full user message>", claude_reply="<full assistant reply>", files_touched=[...], injected_memory_ids=[])
```
The `claude_reply` parameter is the MCP field name for your full assistant reply (any editor).
Increment sequence by 1 after each successful call.

If topic_shift=true is returned, note it for follow-up context retrieval.

### Session end (last thing)
```
sensing_end_session(session_id="<stored session_id>", summary="one sentence: what was accomplished")
```
<!-- /robrain -->

