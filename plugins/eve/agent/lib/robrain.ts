// Shared RoBrain Perception client for the eve agent.
// Mirrors plugins/claude-code/hooks/lib.mjs in the robrain repo: env-first
// config, hard timeouts, fail-open always — a dead Perception must never
// break the agent's session.

// localhost → 127.0.0.1: Node 17+ resolves localhost IPv6-first (::1) but the
// Docker stack only binds 127.0.0.1; old configs may still carry localhost.
function normalizeLoopbackUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "localhost") {
      u.hostname = "127.0.0.1";
      return u.toString().replace(/\/$/, "");
    }
  } catch {
    // not a parseable URL — leave as-is
  }
  return url;
}

const PERCEPTION_URL = normalizeLoopbackUrl(
  process.env.PERCEPTION_API_URL?.trim() || "http://127.0.0.1:3001",
);
const PERCEPTION_KEY = process.env.PERCEPTION_API_KEY?.trim() || "";
export const PROJECT_ID = process.env.ROBRAIN_PROJECT_ID?.trim() || "";

export async function perceptionFetch(
  path: string,
  init: RequestInit = {},
  timeoutMs = 3000,
): Promise<any | null> {
  try {
    const res = await fetch(`${PERCEPTION_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(PERCEPTION_KEY ? { Authorization: `Bearer ${PERCEPTION_KEY}` } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export interface VetoDecision {
  id?: string;
  decision: string;
  rationale?: string;
  similarity?: number;
  exact?: boolean;
  rejected: Array<{ option: string; reason: string }>;
}

/**
 * Two-tier veto scan, same shape as the Claude Code / Codex hooks:
 *  tier 1 — POST /veto-scan: deterministic exact match on rejected[] options
 *           (no embeddings; exempt from the similarity gate);
 *  tier 2 — GET /decisions?query=: semantic search, similarity-gated on the
 *           raw score, never planning_score — a rejection must not fade from
 *           warnings just because it is old.
 * Exact matches come first; results are deduped by decision id.
 */
export async function scanForVetoes(text: string, limit = 8): Promise<VetoDecision[]> {
  if (!PROJECT_ID || !text.trim()) return [];

  const scan = await perceptionFetch(
    "/veto-scan",
    { method: "POST", body: JSON.stringify({ project_id: PROJECT_ID, text: text.slice(0, 2000) }) },
    1500,
  );
  const exact: VetoDecision[] = (Array.isArray(scan?.matches) ? scan.matches : []).map(
    (m: any) => ({ ...m, exact: true }),
  );

  const MIN_SIMILARITY = 0.45;
  let semantic: VetoDecision[] = [];
  const params = new URLSearchParams({
    project_id: PROJECT_ID,
    query: text.slice(0, 2000),
    limit: String(limit),
  });
  const data = await perceptionFetch(`/decisions?${params}`, {}, 2500);
  const decisions = Array.isArray(data) ? data : data?.decisions;
  if (Array.isArray(decisions)) {
    semantic = decisions
      .filter((d: any) => Array.isArray(d.rejected) && d.rejected.length > 0)
      .filter((d: any) => typeof d.similarity !== "number" || d.similarity >= MIN_SIMILARITY)
      .sort((a: any, b: any) => (b.similarity ?? 0) - (a.similarity ?? 0));
  }

  const seen = new Set<string>();
  const merged: VetoDecision[] = [];
  for (const d of [...exact, ...semantic]) {
    const key = d.id ?? d.decision;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(d);
  }
  return merged;
}

export async function alwaysOnSummary(): Promise<string | null> {
  if (!PROJECT_ID) return null;
  const summary = await perceptionFetch(`/projects/${PROJECT_ID}/summary`, {}, 3000);
  const text = summary?.summary ?? summary?.always_on_summary;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}
