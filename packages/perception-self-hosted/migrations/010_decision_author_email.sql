-- Version 10 — who decided.
--
-- decisions.author_email: the git user.email of the session that produced
-- the row (Sensing sends it with each signal; ROBRAIN_AUTHOR_EMAIL
-- overrides). Rules added by hand (POST /projects/:id/rules) carry the
-- email given on the request. NULL on every row saved before this
-- migration; nothing is backfilled.
--
-- Shown in `robrain review`, `robrain search`, the always-on summary and
-- veto warnings, so a rule that fires says who decided it and when.
ALTER TABLE $SCHEMA.decisions
  ADD COLUMN IF NOT EXISTS author_email TEXT;
