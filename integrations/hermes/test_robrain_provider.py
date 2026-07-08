"""Tests for the RoBrain memory provider plugin.

Covers config schema completeness, availability gating, write gating for
non-primary agent contexts, sanitization + short-turn filtering in
sync_turn, fail-open behavior when Perception is unreachable, decision
formatting (REJECTED rendering), the search tool handler, the client's
response unwrapping, and save_config round-trip. No network — the HTTP
client is stubbed throughout.
"""

from __future__ import annotations

import json
import queue

import pytest

from plugins.memory.robrain import RoBrainProvider, _format_decisions
from plugins.memory.robrain.client import RoBrainClient, RoBrainClientError


class StubClient:
    """In-memory stand-in for RoBrainClient."""

    def __init__(self, *, summary="", rows=None, fail=False):
        self.summary = summary
        self.rows = rows or []
        self.fail = fail
        self.posted = []

    def get_summary(self):
        if self.fail:
            raise RoBrainClientError("connection refused")
        return {"always_on_summary": self.summary, "mission": None}

    def search_decisions(self, query, *, limit=5, boost_files=None):
        if self.fail:
            raise RoBrainClientError("connection refused")
        return self.rows[:limit]

    def post_turn_signal(self, **kwargs):
        if self.fail:
            raise RoBrainClientError("connection refused")
        self.posted.append(kwargs)
        return {"accepted": True}


def make_provider(client=None, *, agent_context="primary", tmp_path=None):
    provider = RoBrainProvider()
    provider._session_id = "session-1"
    provider._writes_enabled = agent_context == "primary"
    provider._config = {"scope": "team"}
    provider._client = client if client is not None else StubClient()
    return provider


DECISION_ROW = {
    "decision": "Use webhooks for billing sync",
    "rationale": "near-real-time and cheaper",
    "rejected": [{"option": "polling", "reason": "wasteful at our volume"}],
    "planning_score": 0.48,
    "created_at": "2026-07-08T12:00:00Z",
    "reviewed_at": None,
}


# -- config / availability ---------------------------------------------------


def test_config_schema_has_required_fields_and_secret_key():
    schema = RoBrainProvider().get_config_schema()
    keys = {f["key"] for f in schema}
    assert {"base_url", "project_id", "scope", "api_key"} <= keys
    api_key = next(f for f in schema if f["key"] == "api_key")
    assert api_key["secret"] is True
    assert api_key["env_var"] == "PERCEPTION_API_KEY"


def test_is_available_false_without_config_or_env(monkeypatch, tmp_path):
    monkeypatch.delenv("PERCEPTION_API_KEY", raising=False)
    monkeypatch.setattr(
        "hermes_constants.get_hermes_home", lambda: tmp_path, raising=False
    )
    assert RoBrainProvider().is_available() is False


def test_is_available_true_with_env_key(monkeypatch, tmp_path):
    monkeypatch.setenv("PERCEPTION_API_KEY", "test-key")
    monkeypatch.setattr(
        "hermes_constants.get_hermes_home", lambda: tmp_path, raising=False
    )
    assert RoBrainProvider().is_available() is True


def test_save_config_writes_json(tmp_path):
    provider = RoBrainProvider()
    provider.save_config(
        {"base_url": "http://box:3001", "project_id": "proj-1", "scope": "user"},
        str(tmp_path),
    )
    written = json.loads((tmp_path / "robrain" / "config.json").read_text())
    assert written == {
        "base_url": "http://box:3001",
        "project_id": "proj-1",
        "scope": "user",
    }


# -- capture gating ------------------------------------------------------------


def test_sync_turn_skipped_for_non_primary_context():
    provider = make_provider(agent_context="cron")
    provider.sync_turn("a real user question here", "a real assistant answer here")
    assert provider._write_queue.empty()


def test_sync_turn_skips_trivial_turns():
    provider = make_provider()
    provider.sync_turn("ok", "done")
    assert provider._write_queue.empty()


def test_sync_turn_enqueues_with_incrementing_sequence():
    provider = make_provider()
    provider.sync_turn("should we use polling or webhooks?", "webhooks, because latency")
    provider.sync_turn("and for retries?", "exponential backoff with jitter")
    first = provider._write_queue.get_nowait()
    second = provider._write_queue.get_nowait()
    assert (first["sequence"], second["sequence"]) == (1, 2)
    assert first["session_id"] == "session-1"
    assert first["scope"] == "team"


def test_sync_turn_strips_injected_memory_context():
    provider = make_provider()
    provider.sync_turn(
        "<memory-context>previously injected recall</memory-context>"
        "what HTTP client should the billing integration use?",
        "native fetch with a retry wrapper",
    )
    item = provider._write_queue.get_nowait()
    assert "memory-context" not in item["user_message"]
    assert "previously injected recall" not in item["user_message"]


def test_session_switch_reset_clears_sequence_and_cache():
    provider = make_provider()
    provider.sync_turn("should we use polling or webhooks?", "webhooks, because latency")
    provider._prefetch_cache["session-1"] = "cached"
    provider.on_session_switch("session-2", reset=True)
    assert provider._sequence == 0
    assert provider._prefetch_cache == {}
    assert provider._session_id == "session-2"


def test_shutdown_drains_pending_captures():
    import threading as _threading
    import time as _time

    class SlowClient(StubClient):
        def post_turn_signal(self, **kwargs):
            _time.sleep(0.5)  # simulate server-side extraction latency
            return super().post_turn_signal(**kwargs)

    client = SlowClient()
    provider = make_provider(client)
    provider._writer = _threading.Thread(target=provider._writer_loop, daemon=True)
    provider._writer.start()
    provider.sync_turn(
        "we decided to verify webhook signatures with the SDK",
        "noted: SDK-based verification, not hand-rolled HMAC",
    )
    provider.shutdown()
    assert len(client.posted) == 1  # the in-flight turn landed before exit


# -- fail-open ------------------------------------------------------------------


def test_summary_failure_is_fail_open():
    provider = make_provider(StubClient(fail=True))
    provider._fetch_summary()
    assert provider._degraded is True
    block = provider.system_prompt_block()
    assert "RoBrain decision memory is active" in block


def test_prefetch_search_failure_caches_nothing():
    provider = make_provider(StubClient(fail=True))
    provider._background_search("some query", "session-1")
    assert provider.prefetch("", session_id="session-1") == ""


# -- recall formatting ------------------------------------------------------------


def test_format_decisions_renders_rejected_warnings():
    text = _format_decisions([DECISION_ROW])
    assert "- Use webhooks for billing sync — near-real-time and cheaper" in text
    assert "  - REJECTED: polling — wasteful at our volume" in text


def test_system_prompt_block_includes_summary():
    provider = make_provider(StubClient(summary="Team prefers REST over GraphQL."))
    provider._fetch_summary()
    block = provider.system_prompt_block()
    assert "Team prefers REST over GraphQL." in block


def test_background_search_populates_prefetch():
    provider = make_provider(StubClient(rows=[DECISION_ROW]))
    provider._background_search("billing sync approach", "session-1")
    block = provider.prefetch("", session_id="session-1")
    assert block.startswith("Relevant prior decisions (RoBrain):")
    assert "REJECTED: polling" in block


# -- tool handler -------------------------------------------------------------------


def test_tool_schema_and_unknown_tool():
    provider = make_provider()
    assert [t["name"] for t in provider.get_tool_schemas()] == ["robrain_search"]
    assert json.loads(provider.handle_tool_call("nope", {}))["error"]


def test_search_tool_requires_query():
    provider = make_provider()
    assert json.loads(provider.handle_tool_call("robrain_search", {}))["error"]


def test_search_tool_returns_decisions_with_vetoes():
    provider = make_provider(StubClient(rows=[DECISION_ROW]))
    result = json.loads(
        provider.handle_tool_call("robrain_search", {"query": "billing sync"})
    )
    assert result["count"] == 1
    decision = result["decisions"][0]
    assert decision["decision"] == "Use webhooks for billing sync"
    assert decision["rejected"] == [{"option": "polling", "reason": "wasteful at our volume"}]
    assert decision["reviewed"] is False


def test_search_tool_fail_open_returns_error_json():
    provider = make_provider(StubClient(fail=True))
    result = json.loads(
        provider.handle_tool_call("robrain_search", {"query": "billing sync"})
    )
    assert "RoBrain search failed" in result["error"]


# -- client unwrapping ------------------------------------------------------------------


def test_client_unwraps_decisions_envelope(monkeypatch):
    client = RoBrainClient(api_key="k", project_id="p")
    monkeypatch.setattr(
        client, "_request", lambda *a, **kw: {"decisions": [DECISION_ROW]}
    )
    assert client.search_decisions("q") == [DECISION_ROW]


def test_client_tolerates_bare_list(monkeypatch):
    client = RoBrainClient(api_key="k", project_id="p")
    monkeypatch.setattr(client, "_request", lambda *a, **kw: [DECISION_ROW])
    assert client.search_decisions("q") == [DECISION_ROW]


def test_client_signal_body_shape(monkeypatch):
    captured = {}

    def fake_request(method, path, **kwargs):
        captured.update(method=method, path=path, **kwargs)
        return {"accepted": True}

    client = RoBrainClient(api_key="k", project_id="proj-1")
    monkeypatch.setattr(client, "_request", fake_request)
    client.post_turn_signal(
        session_id="s1",
        sequence=3,
        user_message="u",
        assistant_message="a",
        timestamp="2026-07-08T12:00:00Z",
        scope="user",
    )
    assert captured["path"] == "/signals"
    assert captured["extra_headers"] == {"X-Project-Id": "proj-1"}
    signal = captured["json"]["signal"]
    assert signal["needs_classification"] is True
    assert signal["scope"] == "user"
    assert signal["turn"]["sequence"] == 3
    assert signal["turn"]["claude_reply"] == "a"
