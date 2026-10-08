-- Verify migration 180 (the Comments inbox grouped by post: comment_posts_inbox(), comment_post_reads, comment_post_mark_seen()). Self-contained; run
-- against an empty database or production with 180's migration text concatenated in front when it is not applied yet. Ends in a deliberate error so
-- nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- Proves: one row per POST however many comments it holds (and never a post that has only our own replies, or only deleted comments); the counts
-- (open / replied+resolved / spam / total, customer comments only); the newest CUSTOMER comment is the one shown, not our own later reply; the four
-- views (To do = an open comment, Handled = no open and a replied/resolved one, Spam = any spam comment, All) and the order (newest comment first);
-- the provider filter; search over the caption, the comment text and the author's name or username, with % and _ taken literally and deleted or our
-- own comments never matching; paging; a handled-status change moves a post between views; sample (is_test) comments are kept and flagged; unread
-- (a customer comment that ARRIVED after the person last opened the post; a never-opened post is unread only while it has an open comment; our own
-- reply never lights it; one person's reading never changes another's); a person reads and writes only their own seen rows, only in their own
-- workspace and only for a post of that workspace; another workspace sees no post and no comment; a signed-out caller gets nothing; the two
-- functions are SECURITY INVOKER with a pinned search_path (so they need no guard-catalog allowlist entry) and are not callable by anon; the FKs cascade
-- and the table is picked up by the workspace export (it has account_id).
DO $verify$
DECLARE
  uA      uuid := gen_random_uuid();
  uB      uuid := gen_random_uuid();
  uM      uuid := gen_random_uuid();
  acctA   uuid;
  acctB   uuid;
  p1 uuid; p2 uuid; p3 uuid; p4 uuid; p5 uuid; p6 uuid; p7 uuid; pb uuid;
  v_res   text;
  v_n     bigint;
  v_ts    timestamptz;
BEGIN
  EXECUTE $f$
    CREATE FUNCTION pg_temp.run(u UUID, q TEXT, r TEXT DEFAULT 'authenticated') RETURNS TEXT
    LANGUAGE plpgsql AS $b$
    DECLARE res TEXT;
    BEGIN
      IF u IS NULL THEN
        PERFORM set_config('request.jwt.claims', '', true);
        PERFORM set_config('request.jwt.claim.sub', '', true);
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
        PERFORM set_config('request.jwt.claim.sub', u::text, true);
      END IF;
      EXECUTE format('SET LOCAL ROLE %I', r);
      BEGIN
        IF q ~* '^\s*(select|with)' THEN
          EXECUTE q INTO res;
        ELSE
          EXECUTE q;
        END IF;
        res := COALESCE(res, 'OK');
      EXCEPTION WHEN OTHERS THEN
        res := 'ERR ' || SQLSTATE || ': ' || SQLERRM;
      END;
      EXECUTE 'RESET ROLE';
      PERFORM set_config('request.jwt.claims', '', true);
      PERFORM set_config('request.jwt.claim.sub', '', true);
      RETURN res;
    END $b$;
  $f$;

  -- the posts a person sees for a view, in order, as "P1|P5|..." (the first two characters of each caption)
  EXECUTE $f$
    CREATE FUNCTION pg_temp.inbox(u UUID, a UUID, prov TEXT, f TEXT, s TEXT DEFAULT NULL, lim INT DEFAULT 40, off INT DEFAULT 0, col TEXT DEFAULT 'name') RETURNS TEXT
    LANGUAGE plpgsql AS $b$
    BEGIN
      RETURN pg_temp.run(u, format(
        $q$WITH t AS (SELECT row_number() OVER () AS rn, * FROM public.comment_posts_inbox(%L, %L, %L, %L, %s, %s))
           SELECT COALESCE(string_agg(CASE WHEN %L = 'unread' THEN left(message, 2) || ':' || unread::text ELSE left(message, 2) END, '|' ORDER BY rn), '') FROM t$q$,
        a, prov, f, s, lim, off, col));
    END $b$;
  $f$;

  -- one customer (or our own) comment, "ago" before now
  EXECUTE $f$
    CREATE FUNCTION pg_temp.cm(a UUID, p UUID, prov TEXT, ext TEXT, au TEXT, nm TEXT, un TEXT, tx TEXT, handled TEXT, ago INTERVAL,
                               dir TEXT DEFAULT 'inbound', st TEXT DEFAULT 'visible', test BOOLEAN DEFAULT false) RETURNS UUID
    LANGUAGE plpgsql AS $b$
    DECLARE v UUID;
    BEGIN
      INSERT INTO public.comments (account_id, post_id, provider, external_comment_id, author_external_id, author_name, author_username, text,
                                   direction, status, handled_status, is_test, provider_created_at, created_at)
      VALUES (a, p, prov, ext, au, nm, un, tx, dir, st, handled, test, now() - ago, now() - ago) RETURNING id INTO v;
      RETURN v;
    END $b$;
  $f$;

  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES
    (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now()),
    (uB, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-' || uB || '@example.invalid', '{"full_name":"Tenant B"}', now()),
    (uM, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm-' || uM || '@example.invalid', '{"full_name":"Member of A"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;
  UPDATE profiles SET account_id = acctA, account_role = 'agent' WHERE user_id = uM;

  -- ---- the scenario ---------------------------------------------------------------------------------------------------------------------
  -- P1 Instagram: ayakorose645 comments five times (3 open, 1 replied, 1 resolved), Bob comments (open, newest of the customers), and we replied last.
  -- P2 Facebook: handled only (replied, resolved) plus a deleted comment.      P3 TikTok: one spam, one replied.     P4 Instagram: spam only.
  -- P5 Facebook: one open SAMPLE comment, the newest of all.                   P6 Instagram: only our own comment.   P7 TikTok: only a deleted comment.
  INSERT INTO comment_posts (account_id, provider, channel_ref_id, external_post_id, message, media_url) VALUES (acctA, 'instagram', 'ig-1', 'v180-p1', 'P1 Raya giveaway', 'https://example.invalid/p1.jpg') RETURNING id INTO p1;
  INSERT INTO comment_posts (account_id, provider, channel_ref_id, external_post_id, message) VALUES (acctA, 'facebook', 'fb-1', 'v180-p2', 'P2 Quiet post') RETURNING id INTO p2;
  INSERT INTO comment_posts (account_id, provider, channel_ref_id, external_post_id, message) VALUES (acctA, 'tiktok', 'tt-1', 'v180-p3', 'P3 Dance video') RETURNING id INTO p3;
  INSERT INTO comment_posts (account_id, provider, channel_ref_id, external_post_id, message) VALUES (acctA, 'instagram', 'ig-1', 'v180-p4', 'P4 Spam magnet') RETURNING id INTO p4;
  INSERT INTO comment_posts (account_id, provider, channel_ref_id, external_post_id, message) VALUES (acctA, 'facebook', 'fb-1', 'v180-p5', 'P5 Sample post') RETURNING id INTO p5;
  INSERT INTO comment_posts (account_id, provider, channel_ref_id, external_post_id, message) VALUES (acctA, 'instagram', 'ig-1', 'v180-p6', 'P6 Our words only') RETURNING id INTO p6;
  INSERT INTO comment_posts (account_id, provider, channel_ref_id, external_post_id, message) VALUES (acctA, 'tiktok', 'tt-1', 'v180-p7', 'P7 Deleted only') RETURNING id INTO p7;
  INSERT INTO comment_posts (account_id, provider, channel_ref_id, external_post_id, message) VALUES (acctB, 'instagram', 'ig-b', 'v180-pb', 'PB Other workspace') RETURNING id INTO pb;

  PERFORM pg_temp.cm(acctA, p1, 'instagram', 'v180-c1', 'aya', 'Aya Rose', 'ayakorose645', 'first from aya', 'open', interval '6 hours');
  PERFORM pg_temp.cm(acctA, p1, 'instagram', 'v180-c2', 'aya', 'Aya Rose', 'ayakorose645', 'second from aya', 'open', interval '5 hours');
  PERFORM pg_temp.cm(acctA, p1, 'instagram', 'v180-c3', 'aya', 'Aya Rose', 'ayakorose645', 'third from aya', 'open', interval '4 hours');
  PERFORM pg_temp.cm(acctA, p1, 'instagram', 'v180-c4', 'aya', 'Aya Rose', 'ayakorose645', 'fourth from aya', 'replied', interval '3 hours');
  PERFORM pg_temp.cm(acctA, p1, 'instagram', 'v180-c5', 'aya', 'Aya Rose', 'ayakorose645', 'fifth from aya', 'resolved', interval '2 hours');
  PERFORM pg_temp.cm(acctA, p1, 'instagram', 'v180-c6', 'bob', 'Bob', 'bob_b', 'Last from Bob', 'open', interval '1 hour');
  PERFORM pg_temp.cm(acctA, p1, 'instagram', 'v180-c7', NULL, 'Our Page', 'ourpage', 'Thanks for joining', 'resolved', interval '30 minutes', 'outbound');

  PERFORM pg_temp.cm(acctA, p2, 'facebook', 'v180-d1', 'cy', 'Cy', 'cy', 'a reply was sent here', 'replied', interval '7 hours');
  PERFORM pg_temp.cm(acctA, p2, 'facebook', 'v180-d2', 'di', 'Di', 'di', 'needle-in-handled', 'resolved', interval '5 hours');
  PERFORM pg_temp.cm(acctA, p2, 'facebook', 'v180-d3', 'ed', 'Ed', 'ed', 'zzdeleted text', 'open', interval '1 hour', 'inbound', 'deleted');

  PERFORM pg_temp.cm(acctA, p3, 'tiktok', 'v180-e1', 'fa', 'Fa', 'fa', 'buy followers', 'spam', interval '8 hours');
  PERFORM pg_temp.cm(acctA, p3, 'tiktok', 'v180-e2', 'gi', 'Gi', 'gi', 'nice dance', 'replied', interval '3 hours');

  PERFORM pg_temp.cm(acctA, p4, 'instagram', 'v180-f1', 'ha', 'Ha', 'ha', 'save 50% now', 'spam', interval '5 hours');
  PERFORM pg_temp.cm(acctA, p4, 'instagram', 'v180-f2', 'ha', 'Ha', 'ha', 'click the link', 'spam', interval '4 hours');

  PERFORM pg_temp.cm(acctA, p5, 'facebook', 'v180-g1', 'ik', 'Ik', 'ik', 'sample question', 'open', interval '20 minutes', 'inbound', 'visible', true);

  PERFORM pg_temp.cm(acctA, p6, 'instagram', 'v180-h1', NULL, 'Our Page', 'ourpage', 'we posted a comment ourselves', 'resolved', interval '2 hours', 'outbound');
  PERFORM pg_temp.cm(acctA, p7, 'tiktok', 'v180-i1', 'jo', 'Jo', 'jo', 'gone', 'open', interval '2 hours', 'inbound', 'deleted');
  PERFORM pg_temp.cm(acctB, pb, 'instagram', 'v180-j1', 'ke', 'Ke', 'ke', 'other workspace open comment', 'open', interval '10 minutes');

  -- 0. The shape: table, RLS, no anon/public grants, SECURITY INVOKER functions with a pinned search_path, cascading FKs, the index.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.comment_post_reads'::regclass) THEN RAISE EXCEPTION 'FAIL comment_post_reads has no row level security'; END IF;
  IF has_table_privilege('anon', 'public.comment_post_reads', 'SELECT') OR has_table_privilege('anon', 'public.comment_post_reads', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL anon holds a privilege on comment_post_reads';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('comment_posts_inbox', 'comment_post_mark_seen') AND NOT p.prosecdef
     AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%');
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL the two functions should both be SECURITY INVOKER with a pinned search_path (found % of 2)', v_n; END IF;
  IF has_function_privilege('anon', 'public.comment_posts_inbox(uuid,text,text,text,integer,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.comment_post_mark_seen(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL a signed-out caller may execute the comments inbox functions';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.comment_posts_inbox(uuid,text,text,text,integer,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.comment_post_mark_seen(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL a signed-in person may not execute the comments inbox functions';
  END IF;
  SELECT count(*) INTO v_n FROM pg_constraint c
   WHERE c.conrelid = 'public.comment_post_reads'::regclass AND c.contype = 'f' AND c.confdeltype = 'c';
  IF v_n <> 3 THEN RAISE EXCEPTION 'FAIL comment_post_reads should cascade from the workspace, the person and the post (found % of 3)', v_n; END IF;
  IF to_regclass('public.comments_account_post_idx') IS NULL THEN RAISE EXCEPTION 'FAIL the per-post aggregate index is missing'; END IF;
  -- picked up by the workspace export and the workspace deletion (153 discovers every table with an account_id)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'comment_post_reads' AND column_name = 'account_id') THEN
    RAISE EXCEPTION 'FAIL comment_post_reads has no account_id, so the workspace export and deletion would miss it';
  END IF;
  IF to_regprocedure('public.workspace_export_manifest()') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.workspace_export_manifest()) e WHERE e ->> 'table' = 'comment_post_reads') THEN
      RAISE EXCEPTION 'FAIL the workspace export does not include comment_post_reads';
    END IF;
  END IF;

  -- 1. One row per post: five posts, newest comment first; the post with only our words and the post with only a deleted comment are not rows.
  v_res := pg_temp.inbox(uA, acctA, NULL, 'all');
  IF v_res <> 'P5|P1|P3|P4|P2' THEN RAISE EXCEPTION 'FAIL "All" should be one row per post, newest comment first (P5|P1|P3|P4|P2): %', v_res; END IF;
  -- P1 holds six customer comments and is still one row
  v_res := pg_temp.run(uA, format($q$SELECT open_count || '/' || done_count || '/' || spam_count || '/' || total_count || '/' || last_comment_text || '/' || last_author_username
      FROM public.comment_posts_inbox(%L, NULL, 'all') WHERE left(message, 2) = 'P1'$q$, acctA));
  IF v_res <> '4/2/0/6/Last from Bob/bob_b' THEN
    RAISE EXCEPTION 'FAIL P1 counts or newest customer comment wrong (expected 4 open / 2 handled / 0 spam / 6 total, last = Bob; our own later reply must not count): %', v_res;
  END IF;
  v_res := pg_temp.run(uA, format($q$SELECT count(*)::text FROM public.comment_posts_inbox(%L, NULL, 'all') WHERE left(message, 2) = 'P1'$q$, acctA));
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL a post with many comments came back as % rows', v_res; END IF;
  -- the post fields travel with the row
  v_res := pg_temp.run(uA, format($q$SELECT provider || '/' || source || '/' || media_url || '/' || has_test::text FROM public.comment_posts_inbox(%L, NULL, 'all') WHERE left(message, 2) = 'P1'$q$, acctA));
  IF v_res <> 'instagram/organic/https://example.invalid/p1.jpg/false' THEN RAISE EXCEPTION 'FAIL the post fields on the row are wrong: %', v_res; END IF;
  -- the deleted comment does not count on P2 (2 comments, not 3)
  v_res := pg_temp.run(uA, format($q$SELECT total_count::text FROM public.comment_posts_inbox(%L, NULL, 'all') WHERE left(message, 2) = 'P2'$q$, acctA));
  IF v_res <> '2' THEN RAISE EXCEPTION 'FAIL a deleted comment was counted on P2: %', v_res; END IF;
  -- the sample comment is kept and flagged
  v_res := pg_temp.run(uA, format($q$SELECT has_test::text FROM public.comment_posts_inbox(%L, NULL, 'all') WHERE left(message, 2) = 'P5'$q$, acctA));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL a post holding a sample comment is not flagged: %', v_res; END IF;

  -- 2. The four views.
  v_res := pg_temp.inbox(uA, acctA, NULL, 'open');
  IF v_res <> 'P5|P1' THEN RAISE EXCEPTION 'FAIL To do should be the posts with an open comment (P5|P1): %', v_res; END IF;
  v_res := pg_temp.inbox(uA, acctA, NULL, 'done');
  IF v_res <> 'P3|P2' THEN RAISE EXCEPTION 'FAIL Handled should be no open comment and a replied/resolved one (P3|P2; P1 still has open ones, P4 has only spam): %', v_res; END IF;
  v_res := pg_temp.inbox(uA, acctA, NULL, 'spam');
  IF v_res <> 'P3|P4' THEN RAISE EXCEPTION 'FAIL Spam should be the posts with a spam comment (P3|P4): %', v_res; END IF;

  -- 3. The provider filter, in every view.
  v_res := pg_temp.inbox(uA, acctA, 'instagram', 'all');
  IF v_res <> 'P1|P4' THEN RAISE EXCEPTION 'FAIL Instagram filter: %', v_res; END IF;
  v_res := pg_temp.inbox(uA, acctA, 'tiktok', 'all');
  IF v_res <> 'P3' THEN RAISE EXCEPTION 'FAIL TikTok filter (the post with only a deleted comment must not appear): %', v_res; END IF;
  v_res := pg_temp.inbox(uA, acctA, 'facebook', 'open');
  IF v_res <> 'P5' THEN RAISE EXCEPTION 'FAIL Facebook + To do: %', v_res; END IF;
  -- the counts follow the provider filter too (a provider filter never mixes in another provider's comments)
  v_res := pg_temp.run(uA, format($q$SELECT total_count::text FROM public.comment_posts_inbox(%L, 'instagram', 'all') WHERE left(message, 2) = 'P1'$q$, acctA));
  IF v_res <> '6' THEN RAISE EXCEPTION 'FAIL a provider filter changed a post''s counts: %', v_res; END IF;

  -- 4. Search: caption, comment text, author name, author username; case-insensitive; % and _ are literal; deleted and our own comments never match.
  v_res := pg_temp.inbox(uA, acctA, NULL, 'all', 'giveaway');
  IF v_res <> 'P1' THEN RAISE EXCEPTION 'FAIL search by caption: %', v_res; END IF;
  v_res := pg_temp.inbox(uA, acctA, NULL, 'all', 'NEEDLE-in-handled');
  IF v_res <> 'P2' THEN RAISE EXCEPTION 'FAIL search by comment text (case-insensitive): %', v_res; END IF;
  v_res := pg_temp.inbox(uA, acctA, NULL, 'all', 'ayakorose');
  IF v_res <> 'P1' THEN RAISE EXCEPTION 'FAIL search by author username: %', v_res; END IF;
  v_res := pg_temp.inbox(uA, acctA, NULL, 'all', 'aya rose');
  IF v_res <> 'P1' THEN RAISE EXCEPTION 'FAIL search by author name: %', v_res; END IF;
  v_res := pg_temp.inbox(uA, acctA, NULL, 'all', '%');
  IF v_res <> 'P4' THEN RAISE EXCEPTION 'FAIL a lone %% should match only text that contains a percent sign (P4), not everything: %', v_res; END IF;
  v_res := pg_temp.inbox(uA, acctA, NULL, 'all', '_');
  IF v_res <> 'P1' THEN RAISE EXCEPTION 'FAIL a lone _ should match only text that contains an underscore (bob_b on P1), not everything: %', v_res; END IF;
  v_res := pg_temp.inbox(uA, acctA, NULL, 'all', 'zzdeleted');
  IF v_res <> '' THEN RAISE EXCEPTION 'FAIL search matched a deleted comment: %', v_res; END IF;
  v_res := pg_temp.inbox(uA, acctA, NULL, 'all', 'Thanks for joining');
  IF v_res <> '' THEN RAISE EXCEPTION 'FAIL search matched our own reply: %', v_res; END IF;
  v_res := pg_temp.inbox(uA, acctA, NULL, 'open', 'needle-in-handled');
  IF v_res <> '' THEN RAISE EXCEPTION 'FAIL search ignored the view (a handled post shown under To do): %', v_res; END IF;
  v_res := pg_temp.inbox(uA, acctA, 'tiktok', 'all', 'giveaway');
  IF v_res <> '' THEN RAISE EXCEPTION 'FAIL search ignored the provider filter: %', v_res; END IF;
  v_res := pg_temp.inbox(uA, acctA, NULL, 'all', '   ');
  IF v_res <> 'P5|P1|P3|P4|P2' THEN RAISE EXCEPTION 'FAIL a blank search should not filter: %', v_res; END IF;

  -- 5. Paging is stable and complete.
  v_res := pg_temp.inbox(uA, acctA, NULL, 'all', NULL, 2, 0) || '/' || pg_temp.inbox(uA, acctA, NULL, 'all', NULL, 2, 2) || '/' || pg_temp.inbox(uA, acctA, NULL, 'all', NULL, 2, 4);
  IF v_res <> 'P5|P1/P3|P4/P2' THEN RAISE EXCEPTION 'FAIL paging (2 per page): %', v_res; END IF;

  -- 6. Bad input is refused, not guessed.
  v_res := pg_temp.run(uA, format($q$SELECT count(*)::text FROM public.comment_posts_inbox(%L, NULL, 'bogus')$q$, acctA));
  IF v_res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL an unknown view was accepted: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$SELECT count(*)::text FROM public.comment_posts_inbox(%L, 'myspace', 'all')$q$, acctA));
  IF v_res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL an unknown provider was accepted: %', v_res; END IF;

  -- 7. A status change moves a post between views, and a post leaves To do when its last open comment is handled.
  UPDATE comments SET handled_status = 'resolved' WHERE external_comment_id = 'v180-g1' AND account_id = acctA;
  v_res := pg_temp.inbox(uA, acctA, NULL, 'open') || '/' || pg_temp.inbox(uA, acctA, NULL, 'done');
  IF v_res <> 'P1/P5|P3|P2' THEN RAISE EXCEPTION 'FAIL handling P5''s only open comment should move it from To do to Handled: %', v_res; END IF;
  UPDATE comments SET handled_status = 'open' WHERE external_comment_id = 'v180-g1' AND account_id = acctA;
  -- P1 keeps showing under To do while one comment is open, and leaves when the last is handled
  UPDATE comments SET handled_status = 'resolved' WHERE post_id = p1 AND handled_status = 'open' AND external_comment_id <> 'v180-c6';
  v_res := pg_temp.inbox(uA, acctA, NULL, 'open');
  IF v_res <> 'P5|P1' THEN RAISE EXCEPTION 'FAIL P1 left To do while Bob''s comment is still open: %', v_res; END IF;
  UPDATE comments SET handled_status = 'replied' WHERE external_comment_id = 'v180-c6' AND account_id = acctA;
  v_res := pg_temp.inbox(uA, acctA, NULL, 'open') || '/' || pg_temp.inbox(uA, acctA, NULL, 'done');
  IF v_res <> 'P5/P1|P3|P2' THEN RAISE EXCEPTION 'FAIL P1 should leave To do and enter Handled once no comment is open: %', v_res; END IF;
  -- put the data back for the unread checks: three of aya's comments and Bob's open again
  UPDATE comments SET handled_status = 'open' WHERE external_comment_id IN ('v180-c1', 'v180-c2', 'v180-c3', 'v180-c6') AND account_id = acctA;

  -- 8. Unread. Nobody has opened anything: a post is unread only while it has an open comment.
  v_res := pg_temp.inbox(uA, acctA, NULL, 'all', NULL, 40, 0, 'unread');
  IF v_res <> 'P5:true|P1:true|P3:false|P4:false|P2:false' THEN RAISE EXCEPTION 'FAIL initial unread flags: %', v_res; END IF;
  -- opening P1 clears it for the person who opened it, only
  v_res := pg_temp.run(uA, format($q$SELECT public.comment_post_mark_seen(%L)::text$q$, p1));
  IF v_res LIKE 'ERR%' OR v_res = 'OK' THEN RAISE EXCEPTION 'FAIL mark_seen did not return a time: %', v_res; END IF;
  v_res := pg_temp.inbox(uA, acctA, NULL, 'all', NULL, 40, 0, 'unread');
  IF v_res <> 'P5:true|P1:false|P3:false|P4:false|P2:false' THEN RAISE EXCEPTION 'FAIL opening P1 did not clear its dot for the person who opened it: %', v_res; END IF;
  v_res := pg_temp.inbox(uM, acctA, NULL, 'all', NULL, 40, 0, 'unread');
  IF v_res <> 'P5:true|P1:true|P3:false|P4:false|P2:false' THEN RAISE EXCEPTION 'FAIL one person opening P1 changed another person''s dot: %', v_res; END IF;
  -- our own reply arriving later never lights the dot
  PERFORM pg_temp.cm(acctA, p1, 'instagram', 'v180-c8', NULL, 'Our Page', 'ourpage', 'we answered again', 'resolved', interval '-1 minute', 'outbound');
  v_res := pg_temp.inbox(uA, acctA, NULL, 'all', NULL, 40, 0, 'unread');
  IF v_res NOT LIKE '%P1:false%' THEN RAISE EXCEPTION 'FAIL our own newer reply lit the dot: %', v_res; END IF;
  -- a customer comment arriving after the person last opened it lights it again, for both people
  PERFORM pg_temp.cm(acctA, p1, 'instagram', 'v180-c9', 'bob', 'Bob', 'bob_b', 'one more from Bob', 'open', interval '-2 minutes');
  v_res := pg_temp.inbox(uA, acctA, NULL, 'all', NULL, 40, 0, 'unread');
  IF v_res NOT LIKE '%P1:true%' THEN RAISE EXCEPTION 'FAIL a new customer comment did not light the dot again: %', v_res; END IF;
  -- the newest comment is the one that arrived, and the post count went up, still one row
  v_res := pg_temp.run(uA, format($q$SELECT open_count || '/' || total_count || '/' || last_comment_text FROM public.comment_posts_inbox(%L, NULL, 'all') WHERE left(message, 2) = 'P1'$q$, acctA));
  IF v_res <> '5/7/one more from Bob' THEN RAISE EXCEPTION 'FAIL the post row did not pick up the new comment (expected 5 open / 7 total / the new text): %', v_res; END IF;
  v_res := pg_temp.inbox(uA, acctA, NULL, 'all');
  IF v_res <> 'P1|P5|P3|P4|P2' THEN RAISE EXCEPTION 'FAIL a new comment should move its post to the top: %', v_res; END IF;
  -- seen_at is a real column of the row and later opens never move it backwards
  UPDATE comment_post_reads SET seen_at = now() + interval '5 minutes' WHERE user_id = uA AND post_id = p1;
  v_res := pg_temp.inbox(uA, acctA, NULL, 'all', NULL, 40, 0, 'unread');
  IF v_res NOT LIKE '%P1:false%' THEN RAISE EXCEPTION 'FAIL a seen time after the newest comment did not clear the dot: %', v_res; END IF;
  PERFORM pg_temp.run(uA, format($q$SELECT public.comment_post_mark_seen(%L)::text$q$, p1));
  SELECT seen_at INTO v_ts FROM comment_post_reads WHERE user_id = uA AND post_id = p1;
  IF v_ts < now() + interval '4 minutes' THEN RAISE EXCEPTION 'FAIL opening a post moved the seen time backwards: %', v_ts; END IF;
  SELECT count(*) INTO v_n FROM comment_post_reads WHERE user_id = uA AND post_id = p1;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL opening a post twice made % rows', v_n; END IF;

  -- 9. Whose rows: a person reads and writes only their own, in their own workspace, for a post of that workspace.
  PERFORM pg_temp.run(uM, format($q$SELECT public.comment_post_mark_seen(%L)::text$q$, p2));
  v_res := pg_temp.run(uA, 'SELECT count(*)::text FROM comment_post_reads');
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL a person can read someone else''s seen rows (expected only their own 1): %', v_res; END IF;
  v_res := pg_temp.run(uM, 'SELECT count(*)::text FROM comment_post_reads');
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL the other member should see exactly their own 1 row: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$WITH u AS (UPDATE comment_post_reads SET seen_at = now() WHERE user_id = %L RETURNING 1) SELECT count(*)::text FROM u$q$, uM));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL a person changed someone else''s seen row: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$WITH d AS (DELETE FROM comment_post_reads WHERE user_id = %L RETURNING 1) SELECT count(*)::text FROM d$q$, uM));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL a person deleted someone else''s seen row: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO comment_post_reads (account_id, user_id, post_id) VALUES (%L, %L, %L)$q$, acctA, uM, p3));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a person wrote a seen row for someone else: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO comment_post_reads (account_id, user_id, post_id) VALUES (%L, %L, %L)$q$, acctA, uA, pb));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a person wrote a seen row for a post of another workspace: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO comment_post_reads (account_id, user_id, post_id) VALUES (%L, %L, %L)$q$, acctB, uA, pb));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a person wrote a seen row into a workspace they do not belong to: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO comment_post_reads (account_id, user_id, post_id) VALUES (%L, %L, %L)$q$, acctB, uA, p3));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a seen row whose workspace does not match its post was accepted: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO comment_post_reads (account_id, user_id, post_id) VALUES (%L, %L, %L)$q$, acctA, uA, p3));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL a person could not write their own seen row for a post of their workspace: %', v_res; END IF;

  -- 10. Another workspace, and a signed-out caller.
  v_res := pg_temp.inbox(uB, acctA, NULL, 'all');
  IF v_res <> '' THEN RAISE EXCEPTION 'FAIL another workspace saw this workspace''s posts: %', v_res; END IF;
  v_res := pg_temp.inbox(uB, acctB, NULL, 'all');
  IF v_res <> 'PB' THEN RAISE EXCEPTION 'FAIL the other workspace should see exactly its own post: %', v_res; END IF;
  v_res := pg_temp.inbox(uA, acctB, NULL, 'all');
  IF v_res <> '' THEN RAISE EXCEPTION 'FAIL asking for another workspace''s inbox returned posts: %', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT COALESCE(public.comment_post_mark_seen(%L)::text, 'null')$q$, p1));
  IF v_res <> 'null' THEN RAISE EXCEPTION 'FAIL another workspace could mark this workspace''s post seen: %', v_res; END IF;
  SELECT count(*) INTO v_n FROM comment_post_reads WHERE user_id = uB;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL a seen row was created for a post of another workspace'; END IF;
  v_res := pg_temp.run(uB, 'SELECT count(*)::text FROM comments WHERE account_id = ' || quote_literal(acctA));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL another workspace can read this workspace''s comments: %', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$SELECT count(*)::text FROM public.comment_posts_inbox(%L, NULL, 'all')$q$, acctA));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL a caller with no identity saw posts: %', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$SELECT public.comment_post_mark_seen(%L)::text$q$, p1));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a caller with no identity could mark a post seen: %', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$SELECT count(*)::text FROM public.comment_posts_inbox(%L, NULL, 'all')$q$, acctA), 'anon');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-out caller could run the inbox query: %', v_res; END IF;
  v_res := pg_temp.run(NULL, 'SELECT count(*)::text FROM comment_post_reads', 'anon');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-out caller could read seen rows: %', v_res; END IF;

  -- 11. Cascades: the person's rows go with the post.
  DELETE FROM comment_posts WHERE id = p2;
  SELECT count(*) INTO v_n FROM comment_post_reads WHERE post_id = p2;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL a deleted post left its seen rows behind'; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: the Comments inbox is one row per post (never a row per comment, never a post with only our own replies or only deleted comments) with correct open / handled / spam / total counts and the newest CUSTOMER comment; To do, Handled, Spam and All follow the stated rules and a status change moves a post between them; the provider filter and the search (caption, comment text, author name and username; case-insensitive; %% and _ literal; deleted and own comments never match) work and compose; paging is stable; unknown views and providers are refused; sample comments are kept and flagged; a new comment moves its post to the top and raises its counts; unread means a customer comment arrived after the person last opened the post (own replies never count, a never-opened post is unread only while it has an open comment, one person''s reading never changes another''s, opening never moves the seen time back); a person reads and writes only their own seen rows, only in their own workspace and only for a post of it; another workspace and a signed-out caller get nothing; both functions are SECURITY INVOKER with a pinned search_path and not callable by anon; the table cascades with the workspace, the person and the post and is covered by the workspace export.';
END
$verify$;
