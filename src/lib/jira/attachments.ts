// ============================================================
// Attachments both ways (0.45.0). Opt-in: settings.direction.attachments.
//
//   Vircle -> Jira   sendTicketAttachment: a file from the ticket (our own
//                    chat-media path, never a URL somebody typed) is read from
//                    storage on the server and posted as multipart to
//                    POST /issue/{key}/attachments. Caps: the site's upload
//                    limit (10 MB when it does not say), 20 files per issue,
//                    a MIME sanity check, a sanitised file name. The map row
//                    (ticket attachment <-> Jira attachment id, content hash)
//                    is written the moment Jira answers, so the webhook that
//                    announces the upload is recognised as our own.
//   Jira -> Vircle   pullAttachments: new files on the issue are downloaded
//                    through the authenticated content endpoint (Atlassian
//                    hosts only, 16 MB) and stored as ticket attachments
//                    tagged "from Jira". Types outside the bucket's allow-list
//                    are recorded as "skipped (type)" with a link to the file
//                    in Jira; nothing Jira supplies is ever rendered as HTML.
//
// Everything is injected (store, client, storage), so it is tested with fakes.
// ============================================================

import { createHash } from "node:crypto";

import { buildMediaPath } from "@/lib/storage/upload-media";

import {
  baseMime,
  checkMimeSanity,
  extensionFor,
  FROM_JIRA_MAX_BYTES,
  isAcceptedFromJira,
  isOwnTicketPath,
  isSendableMime,
  MAX_FILES_PER_ISSUE,
  PULL_BATCH,
  sanitizeFilename,
  uploadCap,
} from "./attachment-rules";
import type { JiraClient } from "./client";
import { describeError, JiraNotFoundError, JiraPermissionError, JiraValidationError } from "./errors";
import { effectiveSettings } from "./settings";
import type { AttachmentMapRow, JiraStore } from "./store";
import type { JiraAttachmentRef, JiraConnectionRow, JiraIssue, JiraSettings, TicketJiraLinkRow } from "./types";

/** The Storage surface this needs (the service-role `storage.from("chat-media")`). */
export interface AttachmentStorage {
  download(path: string): Promise<Uint8Array | null>;
  upload(path: string, data: Uint8Array, contentType: string): Promise<{ error: string | null }>;
  remove(path: string): Promise<void>;
  publicUrl(path: string): string;
}

export type AttachmentClient = Pick<JiraClient, "getAttachmentMeta" | "uploadAttachment" | "downloadAttachment">;

export interface AttachmentContext {
  store: JiraStore;
  client: AttachmentClient;
  storage: AttachmentStorage;
  connection: JiraConnectionRow;
  settings: JiraSettings;
  now?: () => number;
}

export const CHAT_MEDIA_BUCKET = "chat-media";
const TICKET_FOLDER = "tickets";
/** A ticket holds at most this many files (the same rule as the Attachments section). */
export const TICKET_FILE_LIMIT = 20;

export const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

// ------------------------------------------------------------
// Vircle -> Jira
// ------------------------------------------------------------

export interface SendResult {
  linkId: string;
  key: string;
  ok: boolean;
  /** sent | already | duplicate | an error code (see Jira.errors) */
  code: string;
}

/** Codes that describe this file, not the connection: nothing to retry. */
const PERMANENT = new Set([
  "toggle_off",
  "from_jira",
  "bad_path",
  "too_large",
  "issue_full",
  "mime_refused",
  "mime_mismatch",
  "active_content",
  "attachments_disabled",
  "already",
  "duplicate",
  "not_found",
  "permission",
]);
export const isPermanentSendCode = (code: string): boolean => PERMANENT.has(code);

/**
 * Send one ticket attachment to the linked issue(s): every healthy link of the
 * ticket, or just `linkId`. `auto` marks a send the workspace asked for by
 * itself ("send all new attachments"): it needs that switch on for the link's
 * project, a manual send only needs attachments on.
 */
export async function sendTicketAttachment(
  ctx: AttachmentContext,
  args: { attachmentId: string; linkId?: string; auto?: boolean },
): Promise<SendResult[]> {
  const { store } = ctx;
  const att = await store.getTicketAttachment(args.attachmentId);
  if (!att || att.account_id !== ctx.connection.account_id) return [{ linkId: args.linkId ?? "", key: "", ok: false, code: "not_found" }];
  // A file that came from Jira is never sent back.
  if (att.source === "jira") return [{ linkId: args.linkId ?? "", key: "", ok: false, code: "from_jira" }];
  if (!isOwnTicketPath(att.account_id, att.storage_path)) return [{ linkId: args.linkId ?? "", key: "", ok: false, code: "bad_path" }];

  const links = (await store.linksForTicket(att.ticket_id)).filter((l) => l.sync_state === "ok" && (!args.linkId || l.id === args.linkId));
  if (links.length === 0) return [{ linkId: args.linkId ?? "", key: "", ok: false, code: "not_found" }];

  const results: SendResult[] = [];
  let bytes: Uint8Array | null | undefined;
  let hash = "";
  let meta: { enabled?: boolean; uploadLimit?: number } | null | undefined;
  let retryable: unknown = null;

  for (const link of links) {
    const done = (code: string, ok = false) => results.push({ linkId: link.id, key: link.issue_key, ok, code });
    const eff = effectiveSettings(ctx.settings, link.project_key);
    if (!eff.direction.attachments || (args.auto && !eff.direction.attachments_auto)) {
      done("toggle_off");
      continue;
    }
    const maps = await store.listAttachmentMaps(link.id);
    if (maps.some((m) => m.ticket_attachment_id === att.id && m.status === "synced")) {
      done("already", true);
      continue;
    }
    if (maps.filter((m) => m.status === "synced").length >= MAX_FILES_PER_ISSUE) {
      done("issue_full");
      continue;
    }
    if (!isSendableMime(att.mime_type)) {
      done("mime_refused");
      continue;
    }

    try {
      if (meta === undefined) meta = await ctx.client.getAttachmentMeta();
      if (meta && meta.enabled === false) {
        done("attachments_disabled");
        continue;
      }
      const cap = uploadCap(meta);
      if (att.size_bytes > cap) {
        done("too_large");
        continue;
      }
      if (bytes === undefined) {
        bytes = await ctx.storage.download(att.storage_path);
        if (bytes) hash = sha256(bytes);
      }
      if (!bytes) {
        done("not_found");
        continue;
      }
      // The size that counts is the real one, not the row's claim.
      if (bytes.byteLength > cap) {
        done("too_large");
        continue;
      }
      const sane = checkMimeSanity(att.mime_type, bytes);
      if (!sane.ok) {
        done(sane.reason);
        continue;
      }
      if (maps.some((m) => m.status === "synced" && m.content_hash === hash)) {
        done("duplicate", true);
        continue;
      }

      const filename = sanitizeFilename(att.filename);
      const created = await ctx.client.uploadAttachment(link.issue_id, {
        filename,
        contentType: baseMime(att.mime_type) || "application/octet-stream",
        data: bytes,
      });
      const first = Array.isArray(created) ? created[0] : null;
      if (first?.id) {
        // Recorded before any webhook can announce it: that is the echo guard.
        await store.insertAttachmentMap({
          account_id: link.account_id,
          link_id: link.id,
          ticket_attachment_id: att.id,
          jira_attachment_id: String(first.id),
          direction: "to_jira",
          status: "synced",
          content_hash: hash,
          filename,
          mime_type: baseMime(att.mime_type),
          size_bytes: bytes.byteLength,
          jira_url: null,
          error: null,
        });
      }
      await store.logEvent({
        accountId: link.account_id,
        connectionId: ctx.connection.id,
        linkId: link.id,
        level: "info",
        kind: "attachment_sent",
        message: `${link.issue_key}: sent ${filename}`,
      });
      done("sent", true);
    } catch (e) {
      const code =
        e instanceof JiraPermissionError
          ? "permission"
          : e instanceof JiraNotFoundError
            ? "not_found"
            : e instanceof JiraValidationError
              ? "jira_rejected"
              : ((e as { code?: string })?.code ?? "error");
      done(code);
      await store.logEvent({
        accountId: link.account_id,
        connectionId: ctx.connection.id,
        linkId: link.id,
        level: "warn",
        kind: "attachment_send_failed",
        message: `${link.issue_key}: ${describeError(e)}`,
      });
      if ((e as { retryable?: boolean })?.retryable) retryable = e;
    }
  }
  // Rate limits and outages go back to the queue; what was sent is remembered, so a retry is idempotent.
  if (retryable && args.linkId === undefined) throw retryable;
  return results;
}

// ------------------------------------------------------------
// Jira -> Vircle
// ------------------------------------------------------------

export interface PullResult {
  stored: number;
  skipped: number;
  duplicates: number;
  /** More new files are waiting: run again. */
  more: boolean;
}

/**
 * Which of the issue's attachments Vircle has not looked at yet. Only files
 * added since the issue was linked count: what was already attached when a
 * ticket links an existing issue is history, not "new" (comments follow the
 * same rule). `since` is the link's creation time.
 */
export function unseenAttachments(
  issue: JiraIssue,
  maps: readonly Pick<AttachmentMapRow, "jira_attachment_id">[],
  since?: string | null,
): JiraAttachmentRef[] {
  const known = new Set(maps.map((m) => m.jira_attachment_id));
  const list = Array.isArray(issue.fields.attachment) ? issue.fields.attachment : [];
  const floor = since ? Date.parse(since) : NaN;
  return list.filter((a) => {
    if (!a || typeof a.id !== "string" || known.has(a.id)) return false;
    const made = a.created ? Date.parse(a.created) : NaN;
    return !Number.isFinite(floor) || !Number.isFinite(made) || made >= floor;
  });
}

/** The link to the file in Jira for a skipped attachment: Jira's own content URL if it is https, else the issue. */
function jiraFileUrl(link: TicketJiraLinkRow, a: JiraAttachmentRef): string | null {
  if (typeof a.content === "string" && /^https:\/\//i.test(a.content)) return a.content.slice(0, 500);
  return link.issue_url;
}

export async function pullAttachments(ctx: AttachmentContext, link: TicketJiraLinkRow, issue: JiraIssue): Promise<PullResult> {
  const { store } = ctx;
  const out: PullResult = { stored: 0, skipped: 0, duplicates: 0, more: false };
  const eff = effectiveSettings(ctx.settings, issue.fields.project?.key ?? link.project_key);
  if (!eff.direction.attachments) return out;

  const maps = await store.listAttachmentMaps(link.id);
  const fresh = unseenAttachments(issue, maps, link.created_at);
  if (fresh.length === 0) return out;
  const batch = fresh.slice(0, PULL_BATCH);
  out.more = fresh.length > batch.length;

  let count = await store.countTicketAttachments(link.ticket_id);
  const ticket = await store.getTicket(link.ticket_id);
  if (!ticket) return out;

  for (const a of batch) {
    const base = {
      account_id: link.account_id,
      link_id: link.id,
      ticket_attachment_id: null as string | null,
      jira_attachment_id: a.id,
      direction: "from_jira" as const,
      content_hash: null as string | null,
      filename: sanitizeFilename(a.filename),
      mime_type: baseMime(a.mimeType) || null,
      size_bytes: typeof a.size === "number" ? a.size : null,
      jira_url: jiraFileUrl(link, a),
      error: null as string | null,
    };
    const skip = async (status: AttachmentMapRow["status"], why: string) => {
      await store.insertAttachmentMap({ ...base, status, error: why });
      out.skipped += 1;
      await store.logEvent({
        accountId: link.account_id,
        connectionId: ctx.connection.id,
        linkId: link.id,
        level: "info",
        kind: "attachment_skipped",
        message: `${link.issue_key}: ${base.filename} not copied (${why})`,
      });
    };

    if (!isAcceptedFromJira(a.mimeType)) {
      await skip("skipped_type", "type");
      continue;
    }
    if (typeof a.size === "number" && a.size > FROM_JIRA_MAX_BYTES) {
      await skip("skipped_size", "size");
      continue;
    }
    if (count >= TICKET_FILE_LIMIT) {
      await skip("skipped_cap", "ticket_full");
      continue;
    }

    let file: Awaited<ReturnType<AttachmentClient["downloadAttachment"]>>;
    try {
      file = await ctx.client.downloadAttachment(a.id, FROM_JIRA_MAX_BYTES);
    } catch (e) {
      // Rate limit or outage: leave it unrecorded so the follow-up job tries again.
      if ((e as { retryable?: boolean })?.retryable) throw e;
      await skip("failed", "download");
      continue;
    }
    if (!file.ok) {
      if (file.reason === "too_large") await skip("skipped_size", "size");
      else if (file.reason === "not_found") await skip("failed", "not_found");
      else await skip("failed", file.reason);
      continue;
    }
    const sane = checkMimeSanity(a.mimeType, file.data);
    if (!sane.ok) {
      await skip("skipped_type", sane.reason);
      continue;
    }
    const hash = sha256(file.data);
    // Our own upload coming back (the webhook beat the map row), or the same bytes already on the issue.
    if (maps.some((m) => m.content_hash === hash && m.status === "synced")) {
      await store.insertAttachmentMap({ ...base, status: "duplicate", content_hash: null, error: null });
      out.duplicates += 1;
      continue;
    }

    const filename = base.filename;
    const mime = baseMime(a.mimeType);
    const path = buildMediaPath(link.account_id, `${filename.replace(/\.[^.]+$/, "")}.${extensionFor(filename, mime)}`, (ctx.now ?? Date.now)(), TICKET_FOLDER);
    const up = await ctx.storage.upload(path, file.data, mime);
    if (up.error) {
      await skip("failed", "storage");
      continue;
    }
    let attachmentId: string;
    try {
      attachmentId = await store.insertTicketAttachment({
        ticketId: link.ticket_id,
        accountId: link.account_id,
        storagePath: path,
        url: ctx.storage.publicUrl(path),
        filename,
        mimeType: mime,
        sizeBytes: file.data.byteLength,
        jiraAttachmentId: a.id,
      });
    } catch (e) {
      await ctx.storage.remove(path).catch(() => undefined);
      await store.logEvent({
        accountId: link.account_id,
        connectionId: ctx.connection.id,
        linkId: link.id,
        level: "warn",
        kind: "attachment_store_failed",
        message: `${link.issue_key}: ${describeError(e)}`,
      });
      continue;
    }
    const recorded = await store.insertAttachmentMap({
      ...base,
      ticket_attachment_id: attachmentId,
      status: "synced",
      content_hash: hash,
      size_bytes: file.data.byteLength,
    });
    if (!recorded) {
      // A concurrent worker stored the same Jira attachment first: keep one copy.
      await store.deleteTicketAttachment(attachmentId).catch(() => undefined);
      await ctx.storage.remove(path).catch(() => undefined);
      continue;
    }
    maps.push({ ...base, id: "", ticket_attachment_id: attachmentId, status: "synced", content_hash: hash });
    count += 1;
    out.stored += 1;
    await store.logEvent({
      accountId: link.account_id,
      connectionId: ctx.connection.id,
      linkId: link.id,
      level: "info",
      kind: "attachment_pulled",
      message: `${link.issue_key}: stored ${filename}`,
    });
  }
  return out;
}
