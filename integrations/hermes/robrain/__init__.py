"""RoBrain memory plugin — decision memory with structured rejected alternatives.

RoBrain (https://github.com/adelinamart/robrain) is self-hosted decision
memory for agents: it passively captures what got decided in a session AND
the alternatives that were explicitly ruled out, storing each veto as a
structured ``rejected[]`` field (option + reason) in the user's own
Postgres. The point is preventing an agent from re-proposing an approach
the user already rejected — the veto arrives in context as an explicit
warning, with the original reason.

Integration shape:

  system prompt   ← the project's always-on summary (session-start recall)
  prefetch        ← composite-scored semantic retrieval; rejected
                    alternatives rendered as REJECTED warnings
  sync_turn       ← raw turns shipped to Perception, which runs its own
                    server-side decision extraction (no local LLM needed)
  robrain_search  ← on-demand tool for decision + veto lookup

Config chain:
  1. $HERMES_HOME/robrain/config.json  (base_url, project_id, scope)
  2. Environment: PERCEPTION_API_KEY (secret), ROBRAIN_BASE_URL,
     ROBRAIN_PROJECT_ID

Fail-open by design: if the Perception API is down, recall degrades to
nothing and writes are dropped with a warning — the agent never blocks.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.memory_manager import sanitize_context
from agent.memory_provider import MemoryProvider
from tools.registry import tool_error

from .client import RoBrainClient, RoBrainClientError

logger = logging.getLogger(__name__)

_CONFIG_DIRNAME = "robrain"
_CONFIG_FILENAME = "config.json"

# Turns shorter than this carry no decision signal — don't ship them.
_MIN_TURN_CHARS = 20
# Cap what we send per turn; Perception enforces its own MAX_TURN_TEXT too.
_MAX_TURN_CHARS = 20_000
# Shutdown flush window — one POST /signals rides a server-side LLM
# extraction, so the last turn of a short session needs real time to land.
_SHUTDOWN_DRAIN_S = 25.0

SEARCH_SCHEMA = {
    "name": "robrain_search",
    "description": (
        "Search the team's RoBrain decision memory. Returns prior decisions "
        "ranked by relevance, each with its rationale and — critically — the "
        "alternatives that were explicitly REJECTED and why. Use before "
        "proposing a tool, library, architecture, or approach, to avoid "
        "re-suggesting something the user already ruled out."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "What you are about to decide or propose (natural language).",
            },
            "limit": {
                "type": "integer",
                "description": "Max decisions to return (default 5, max 20).",
            },
        },
        "required": ["query"],
    },
}


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _format_decisions(rows: List[Dict[str, Any]]) -> str:
    """Render decisions the way RoBrain's own inject does — vetoes as warnings."""
    lines: List[str] = []
    for row in rows:
        decision = str(row.get("decision") or "").strip()
        if not decision:
            continue
        rationale = str(row.get("rationale") or "").strip()
        lines.append(f"- {decision}" + (f" — {rationale}" if rationale else ""))
        for veto in row.get("rejected") or []:
            option = str(veto.get("option") or "").strip()
            reason = str(veto.get("reason") or "").strip()
            if option:
                lines.append(f"  - REJECTED: {option}" + (f" — {reason}" if reason else ""))
    return "\n".join(lines)


class RoBrainProvider(MemoryProvider):
    """MemoryProvider backed by a self-hosted RoBrain Perception API."""

    def __init__(self) -> None:
        self._client: Any = None
        self._config: Dict[str, Any] = {}
        self._hermes_home: str = ""
        self._session_id: str = ""
        self._writes_enabled = True
        self._degraded = False

        self._summary: str = ""
        self._summary_lock = threading.Lock()

        self._prefetch_cache: Dict[str, str] = {}
        self._prefetch_lock = threading.Lock()

        self._sequence = 0
        self._sequence_lock = threading.Lock()

        self._write_queue: "queue.Queue[Optional[Dict[str, Any]]]" = queue.Queue(maxsize=200)
        self._writer: Optional[threading.Thread] = None
        self._writer_busy = False

    # -- config ---------------------------------------------------------------

    @property
    def name(self) -> str:
        return "robrain"

    @staticmethod
    def _config_path(hermes_home: str) -> Path:
        return Path(hermes_home) / _CONFIG_DIRNAME / _CONFIG_FILENAME

    def _load_config(self, hermes_home: str) -> Dict[str, Any]:
        config: Dict[str, Any] = {}
        path = self._config_path(hermes_home) if hermes_home else None
        if path and path.is_file():
            try:
                config = json.loads(path.read_text(encoding="utf-8")) or {}
            except Exception:
                logger.warning("robrain: unreadable config at %s — using env/defaults", path)
        config.setdefault("base_url", os.environ.get("ROBRAIN_BASE_URL", ""))
        config.setdefault("project_id", os.environ.get("ROBRAIN_PROJECT_ID", ""))
        config.setdefault("scope", "team")
        config["api_key"] = os.environ.get("PERCEPTION_API_KEY", "")
        return config

    def is_available(self) -> bool:
        """Configured = the config file exists or the API key env var is set.

        No network calls here (contract) — reachability is probed in
        initialize(), which fails open.
        """
        try:
            from hermes_constants import get_hermes_home
            if self._config_path(str(get_hermes_home())).is_file():
                return True
        except Exception:
            pass
        return bool(os.environ.get("PERCEPTION_API_KEY"))

    # -- lifecycle -------------------------------------------------------------

    def initialize(self, session_id: str, **kwargs) -> None:
        self._session_id = session_id
        self._hermes_home = str(kwargs.get("hermes_home") or "")
        # Cron/subagent/flush contexts must not write into the decision corpus.
        self._writes_enabled = kwargs.get("agent_context", "primary") == "primary"

        self._config = self._load_config(self._hermes_home)
        self._client = RoBrainClient(
            base_url=self._config.get("base_url") or "",
            api_key=self._config.get("api_key") or "",
            project_id=self._config.get("project_id") or "",
        )

        self._writer = threading.Thread(
            target=self._writer_loop, name="robrain-writer", daemon=True,
        )
        self._writer.start()

        threading.Thread(
            target=self._fetch_summary, name="robrain-summary", daemon=True,
        ).start()

    def _fetch_summary(self) -> None:
        try:
            payload = self._client.get_summary()
        except RoBrainClientError as exc:
            self._degraded = True
            logger.warning("robrain: Perception unreachable at startup (fail-open): %s", exc)
            return
        summary = str(payload.get("always_on_summary") or "").strip()
        with self._summary_lock:
            self._summary = summary
        self._degraded = False

    def shutdown(self) -> None:
        """Flush pending turn captures, then stop the writer.

        A single POST /signals waits on Perception's server-side LLM
        extraction (typically 5–20s), and short-lived sessions (``hermes
        -z``) reach shutdown with the final turn still in flight — a
        too-short drain here silently loses exactly the turn that made
        the session worth remembering. Bounded by _SHUTDOWN_DRAIN_S so a
        wedged server still can't block exit; the writer is a daemon
        thread, so anything past the deadline dies with the interpreter.
        """
        deadline = time.monotonic() + _SHUTDOWN_DRAIN_S
        while not self._write_queue.empty() or self._writer_busy:
            if time.monotonic() >= deadline:
                logger.warning(
                    "robrain: shutdown drain timed out with %d turn(s) unflushed",
                    self._write_queue.qsize(),
                )
                break
            time.sleep(0.2)
        try:
            self._write_queue.put_nowait(None)
        except queue.Full:
            pass
        if self._writer is not None:
            self._writer.join(timeout=max(0.0, deadline - time.monotonic()) + 1.0)

    # -- recall ----------------------------------------------------------------

    def system_prompt_block(self) -> str:
        with self._summary_lock:
            summary = self._summary
        lines = [
            "RoBrain decision memory is active. Prior team decisions — including "
            "explicitly REJECTED alternatives — are injected as context. Never "
            "re-propose a REJECTED option without flagging the recorded reason "
            "and asking the user to confirm the reversal. Use robrain_search "
            "before committing to a tool, library, or architectural approach.",
        ]
        if summary:
            lines.append("")
            lines.append("Project decisions (always-on summary):")
            lines.append(summary)
        return "\n".join(lines)

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        query = (query or "").strip()
        if len(query) < 12 or self._client is None:
            return
        threading.Thread(
            target=self._background_search,
            args=(query, session_id or self._session_id),
            name="robrain-prefetch",
            daemon=True,
        ).start()

    def _background_search(self, query: str, session_id: str) -> None:
        try:
            rows = self._client.search_decisions(query, limit=5)
        except RoBrainClientError as exc:
            logger.debug("robrain: prefetch search failed (fail-open): %s", exc)
            return
        formatted = _format_decisions(rows)
        with self._prefetch_lock:
            self._prefetch_cache[session_id] = (
                f"Relevant prior decisions (RoBrain):\n{formatted}" if formatted else ""
            )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        with self._prefetch_lock:
            return self._prefetch_cache.get(session_id or self._session_id, "")

    # -- capture -----------------------------------------------------------------

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        if not self._writes_enabled or self._client is None:
            return

        # Strip previously injected memory context so recall never re-enters
        # the corpus as a fresh "decision" (feedback loop).
        user_clean = sanitize_context(user_content or "").strip()[:_MAX_TURN_CHARS]
        assistant_clean = sanitize_context(assistant_content or "").strip()[:_MAX_TURN_CHARS]
        if len(user_clean) + len(assistant_clean) < _MIN_TURN_CHARS:
            return

        with self._sequence_lock:
            self._sequence += 1
            sequence = self._sequence

        item = {
            "session_id": session_id or self._session_id,
            "sequence": sequence,
            "user_message": user_clean,
            "assistant_message": assistant_clean,
            "timestamp": _utc_now_iso(),
            "scope": str(self._config.get("scope") or "team"),
        }
        try:
            self._write_queue.put_nowait(item)
        except queue.Full:
            logger.warning("robrain: write queue full — dropping turn %s", sequence)

    def _writer_loop(self) -> None:
        while True:
            item = self._write_queue.get()
            if item is None:
                return
            self._writer_busy = True
            try:
                self._client.post_turn_signal(**item)
            except RoBrainClientError as exc:
                logger.debug("robrain: turn capture failed (fail-open): %s", exc)
            finally:
                self._writer_busy = False

    # -- session lifecycle -------------------------------------------------------

    def on_session_switch(
        self,
        new_session_id: str,
        *,
        parent_session_id: str = "",
        reset: bool = False,
        rewound: bool = False,
        **kwargs,
    ) -> None:
        self._session_id = new_session_id
        if reset:
            with self._sequence_lock:
                self._sequence = 0
            with self._prefetch_lock:
                self._prefetch_cache.clear()

    # -- tools ---------------------------------------------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [SEARCH_SCHEMA]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        if tool_name != "robrain_search":
            return tool_error(f"Unknown tool: {tool_name}")
        if self._client is None:
            return tool_error("RoBrain provider is not initialized")

        query = str(args.get("query") or "").strip()
        if not query:
            return tool_error("query is required")
        limit = args.get("limit") or 5
        try:
            limit = max(1, min(int(limit), 20))
        except (TypeError, ValueError):
            limit = 5

        try:
            rows = self._client.search_decisions(query, limit=limit)
        except RoBrainClientError as exc:
            return tool_error(f"RoBrain search failed: {exc}")

        decisions = [
            {
                "decision": row.get("decision"),
                "rationale": row.get("rationale"),
                "rejected": row.get("rejected") or [],
                "score": row.get("planning_score"),
                "created_at": row.get("created_at"),
                "reviewed": bool(row.get("reviewed_at")),
            }
            for row in rows
        ]
        return json.dumps({"decisions": decisions, "count": len(decisions)})

    # -- setup ------------------------------------------------------------------------

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "base_url",
                "description": "Perception API URL of your RoBrain deployment",
                "default": "http://localhost:3001",
                "required": True,
            },
            {
                "key": "project_id",
                "description": "RoBrain project id (see `npx robrain review` or the projects table)",
                "default": "default",
                "required": True,
            },
            {
                "key": "scope",
                "description": "Scope recorded on captured decisions",
                "default": "team",
                "choices": ["user", "local", "team", "global"],
            },
            {
                "key": "api_key",
                "description": "PERCEPTION_API_KEY from your RoBrain .env",
                "secret": True,
                "required": True,
                "env_var": "PERCEPTION_API_KEY",
                "url": "https://github.com/adelinamart/robrain#security",
            },
        ]

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        path = self._config_path(hermes_home)
        path.parent.mkdir(parents=True, exist_ok=True)
        config = {
            "base_url": values.get("base_url") or "http://localhost:3001",
            "project_id": values.get("project_id") or "default",
            "scope": values.get("scope") or "team",
        }
        path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")


def register_memory_provider() -> MemoryProvider:
    """Entry point used by plugins/memory discovery."""
    return RoBrainProvider()
