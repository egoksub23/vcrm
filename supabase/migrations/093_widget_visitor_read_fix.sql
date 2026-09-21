-- ============================================================
-- 093_widget_visitor_read_fix
--
-- Bug: a web-widget visitor could not read ANY message or conversation, so
-- live replies never arrived and the history came back empty after a reload.
--
-- Cause: the visitor read policies on `messages` and `conversations`
-- (`messages_widget_visitor_select`, `conversations_widget_visitor_select`,
-- migrations 046 / 048) look the visitor up in `widget_visitors`. That table
-- has row level security ENABLED and no policy (migration 046 left it
-- "service role only" on purpose). Postgres applies a subquery table's own row
-- level security to the caller, so the lookup is always empty and both
-- policies match nothing for a visitor.
--
-- Fix: let a signed-in (anonymous) visitor read ONLY their own row. That is
-- exactly what the two policies need; it exposes no other visitor's row and
-- nothing is writable by clients (still service role only).
--
-- Idempotent.
-- ============================================================

DROP POLICY IF EXISTS widget_visitors_self_select ON public.widget_visitors;

CREATE POLICY widget_visitors_self_select
  ON public.widget_visitors
  FOR SELECT
  TO authenticated
  USING (id = auth.uid());
