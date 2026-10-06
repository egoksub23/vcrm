// Doc Sign sealing throughput benchmark. Measures, with the REAL PDF engine (pdf-lib, the bundled fonts, the real
// certificate pages and the real PKCS#12 seal; nothing of the engine is mocked), how long one seal job takes and how
// much memory it needs, and how long the cron batch loop `runSealing` takes over 200 documents. The only fakes are the
// ones the service tests already use: FakeDb (src/lib/sign/service/fake-db.ts) for the database and storage, and a
// mail sender that does nothing. So the numbers are CPU and memory of the engine on THIS machine. They contain no
// network time (database, storage, email) and are NOT numbers of the live server.
//
// Run from the repository root (works in PowerShell, Git Bash and cmd; the repository has no TypeScript runner, so the
// script is bundled first with the esbuild that ships with the tooling, as scripts/build-merchant-template.ts is):
//
//   npx esbuild scripts/sign-seal-benchmark.ts --bundle --platform=node --format=cjs --packages=external --outfile=build/sign-seal-benchmark.cjs && node --expose-gc build/sign-seal-benchmark.cjs
//
// Options (after the .cjs file):  --only a,b,c-max   run only these scenarios   --reps 5   warm repetitions per single-document scenario
//                                 (c-overflow runs at most 1 warm repetition and c-overflow-max none: they take minutes)
//                                 --batch 200        documents in the loop scenarios   --json <file>   also write the results as JSON
// Scenarios: a (4 pages, 6 fields, 1 signer), b (Merchant Application, full form answered, 2 signers),
//            c (50 pages, 300 fields, 1 signer, every answer fits its box), c-overflow (the same, but the 50 multi-line answers are 330 characters
//            in a small box and cannot fit), c-overflow-max (2000 characters, the longest a multi-line answer may be), c-max (the same as c with a
//            400 KB image, the largest allowed, in every signature field), d (190 pages and 300 fields; set SEAL_BENCH_DPAGES to try another count),
//            loop-a and loop-b (200 documents through runSealing, of the kind of a and b).
// Every scenario runs in a fresh child process (node --expose-gc) so memory figures do not leak from one into the next.
// `build/` is ignored by git.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import v8 from "node:v8";
import { Worker } from "node:worker_threads";

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import sharp from "sharp";

import { encrypt } from "../src/lib/whatsapp/encryption";
import { MERCHANT_FORM, MERCHANT_ROLES } from "../src/lib/sign/addons/merchant/form";
import { MERCHANT_PLACEMENTS } from "../src/lib/sign/addons/merchant/layout";
import { resolvedWithSystemLists } from "../src/lib/sign/addons/fixtures";
import type { FormDefinition } from "../src/lib/sign/forms";
import { sealAnswer } from "../src/lib/sign/service/sensitive";
import { FakeDb } from "../src/lib/sign/service/fake-db";
import { runSealing } from "../src/lib/sign/service/seal";
import type { SignCtx } from "../src/lib/sign/service/context";
import { A4, scribblePng } from "../src/lib/sign/pdf/fixtures";
import { createSelfSignedP12 } from "../src/lib/sign/pdf/p12";
import { answerFields, freezeBase } from "../src/lib/sign/pdf/stamp";
import type { PlacedField } from "../src/lib/sign/pdf/types";
import { verifySealed } from "../src/lib/sign/pdf/verify";
import { MAX_FIELDS, MAX_IMAGE_BYTES, type StoredAnswer } from "../src/lib/sign/rules";
import type { NotifyDeps } from "../src/lib/sign/notify";
import type { SignRole } from "../src/lib/sign/types";

const ACCT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const MB = 1024 * 1024;
const mb = (n: number) => Math.round((n / MB) * 10) / 10;

// ---- what a child reports ---------------------------------------------------------------------------------------------

interface ScenarioResult {
  scenario: string;
  title: string;
  pages: number;
  /** Placed fields, and how many of them print a form answer (bound to a data field) rather than being filled in by a signer. */
  fields: number;
  boundFields: number;
  signers: number;
  inputBytes: number;
  outputBytes: number;
  outputPages: number;
  /** One entry per seal job, in order: the first is cold (a fresh process: code not yet compiled, fonts not yet read). */
  runsMs: number[];
  /** Peak process RSS during each run (sampled in a worker thread every 2 ms), and its growth over the baseline taken before the first run. */
  peakRssMb: number[];
  baselineRssMb: number;
  /** Highest heapUsed and external (Buffers) seen at the sampling points (every 5 ms between awaits and at every storage/database call): a lower bound, the engine's synchronous stretches cannot be sampled. */
  peakHeapMb: number;
  baselineHeapMb: number;
  peakExternalMb: number;
  baselineExternalMb: number;
  /** How late a 10 ms timer ran during the job(s): the longest stretch the engine kept the Node event loop (and so every web request of the same process) from running. */
  eventLoopMaxMs: number;
  eventLoopP99Ms: number;
  /** After a forced collection at the end: what stayed allocated. */
  retainedRssMb: number;
  retainedHeapMb: number;
  /** Calls a seal job makes against the database and storage (each one is a network round trip on the live server). */
  callsPerDoc: { queries: number; rpcs: number; storage: number; emails: number };
  /** Loop scenarios only. */
  loop?: { documents: number; ticks: number; perTick: number; totalMs: number; tickMs: number[] };
  sealVerified: boolean;
  errors: string[];
}

// ---- fixtures ---------------------------------------------------------------------------------------------------------

/** A PDF with real page content (about 45 lines of text on each page), closer to a converted contract than the bare fixture. */
async function textPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([A4.w, A4.h]);
    for (let l = 0; l < 45; l++) {
      page.drawText(`Clause ${p + 1}.${l + 1}  The parties agree that the services are provided as described in the schedule and that fees are payable within thirty days.`, { x: 40, y: A4.h - 50 - l * 16, size: 8.5, font, color: rgb(0.15, 0.15, 0.15) });
    }
  }
  return doc.save({ useObjectStreams: false });
}

/** A PNG as large as a signature image may be (MAX_IMAGE_BYTES), made of noise so it does not compress. */
async function largestPng(): Promise<Uint8Array> {
  for (let side = 360; side > 100; side -= 10) {
    const raw = Buffer.alloc(side * side * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
    const png = new Uint8Array(await sharp(raw, { raw: { width: side, height: side, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer());
    if (png.length <= MAX_IMAGE_BYTES) return png;
  }
  throw new Error("could not make an image under the limit");
}

const dataUrl = (png: Uint8Array) => `data:image/png;base64,${Buffer.from(png).toString("base64")}`;

interface Spec {
  title: string;
  roles: SignRole[];
  fields: PlacedField[];
  form: FormDefinition | null;
  /** The sender's file as it was sent (static text already on it). */
  base: Uint8Array;
  pageCount: number;
  people: { role: string; name: string; email: string }[];
  /** The answers a document gets: placed fields by key, then form answers by data field key. */
  answers: (documentId: string, signerOf: (role: string) => string) => { signer: string; key: string; value: StoredAnswer; field?: { sensitive?: boolean } | null }[];
  events: number;
}

// ---- the world --------------------------------------------------------------------------------------------------------

interface Counters {
  queries: number;
  rpcs: number;
  storage: number;
  emails: number;
}

function counted(db: FakeDb, c: Counters, sample: () => void) {
  const inner = db.client();
  const storage = inner.storage as unknown as { from: (b: string) => Record<string, (...a: unknown[]) => Promise<unknown>> };
  return {
    from: (t: string) => {
      c.queries++;
      sample();
      const q = inner.from(t);
      // FakeDb has no array `contains` filter (the webhook lookup uses it); a no-op one lets that lookup run and find nothing, as for a workspace with no webhooks
      (q as unknown as { contains: () => unknown }).contains = () => q;
      return q;
    },
    rpc: (name: string, args?: Record<string, unknown>) => {
      c.rpcs++;
      sample();
      return inner.rpc(name, args);
    },
    storage: {
      from: (b: string) => {
        const real = storage.from(b);
        const wrap = (fn: string) => async (...a: unknown[]) => {
          c.storage++;
          sample();
          return real[fn](...a);
        };
        return { upload: wrap("upload"), download: wrap("download"), copy: wrap("copy"), remove: wrap("remove") };
      },
    },
  } as unknown as SignCtx["admin"];
}

let hex = 0;
const hash = () => (++hex).toString(16).padStart(64, "0");

function seedDocument(db: FakeDb, spec: Spec, n: number): string {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const sentAt = "2026-10-06T02:00:00Z";
  const basePath = `account-${ACCT}/${id}/base/sent-${createHash("sha256").update(spec.base).digest("hex")}.pdf`;
  db.files.set(basePath, spec.base); // the same bytes are shared by every document: FakeDb hands a copy out on each download
  db.seed("sign_documents", [
    {
      id,
      account_id: ACCT,
      reference: `SGN-2026-${String(n).padStart(6, "0")}`,
      title: spec.title,
      status: "sealing",
      mode: "sign",
      test: false,
      sign_in_order: false,
      code_required: false,
      allow_forwarding: false,
      envelope_id: null,
      locale: "en",
      message: null,
      fields_snapshot: spec.fields,
      roles_snapshot: spec.roles,
      form_snapshot: spec.form,
      merge_values: {},
      base_path: basePath,
      base_sha256: createHash("sha256").update(spec.base).digest("hex"),
      page_count: spec.pageCount,
      sent_at: sentAt,
      sealing_started_at: null,
      sealing_attempts: 0,
      created_by: USER,
      created_at: new Date(Date.UTC(2026, 9, 6, 2, 0, 0, n)).toISOString(),
    },
  ]);
  const signerIds = new Map<string, string>();
  spec.people.forEach((p, i) => {
    const sid = `10000000-0000-4000-8000-${String(n * 10 + i).padStart(12, "0")}`;
    signerIds.set(p.role, sid);
    db.seed("sign_signers", [{ id: sid, account_id: ACCT, document_id: id, role_key: p.role, kind: "signer", full_name: p.name, email: p.email, phone: null, channel: "email", order_no: i + 1, status: "signed", invited_at: sentAt, signed_at: `2026-10-06T0${6 + i}:03:00Z`, ip: "203.0.113.9", device: "Chrome on Windows", locale: null, part_keys: null, delegated_by: null, forward_count: 0, forward_history: [], party_id: null }]);
  });
  db.seed(
    "sign_answers",
    spec.answers(id, (role) => signerIds.get(role) as string).map((a) => {
      const sealed = sealAnswer(a.field ?? null, a.value, { documentId: id, fieldKey: a.key });
      return { account_id: ACCT, document_id: id, signer_id: a.signer, field_key: a.key, value: sealed.value, value_enc: sealed.value_enc, source: "signer", saved_at: "2026-10-06T06:00:00Z" };
    }),
  );
  const types = ["sent", "invited", "viewed", "consented", "saved", "signed"];
  const events = Array.from({ length: spec.events }, (_, i) => {
    const who = spec.people.length ? signerIds.get(spec.people[i % spec.people.length].role) ?? null : null;
    return { account_id: ACCT, document_id: id, doc_seq: i + 1, type: i === spec.events - 1 ? "all_signed" : types[i % types.length], signer_id: i === 0 ? null : who, row_hash: hash(), detail: {}, created_at: new Date(Date.UTC(2026, 9, 6, 2, 0, 0) + i * 60_000).toISOString() };
  });
  db.seed("sign_events", events);
  return id;
}

// ---- the specifications -----------------------------------------------------------------------------------------------

const signerRole: SignRole[] = [{ key: "signer", label: "Signer", kind: "signer", color: 0 }];

async function specA(): Promise<Spec> {
  const png = dataUrl(await scribblePng());
  const f = (key: string, type: PlacedField["type"], page: number, y: number, over: Partial<PlacedField> = {}): PlacedField => ({ key, type, role: "signer", page, x: 0.1, y, w: 0.5, h: 0.04, required: true, ...over });
  const fields = [f("biz", "text", 0, 0.2), f("mname", "name", 0, 0.3), f("msig", "signature", 0, 0.4, { h: 0.08, w: 0.4 }), f("mdate", "date_signed", 0, 0.55), f("agree", "checkbox", 1, 0.3, { w: 0.03, h: 0.03 }), f("ini", "initials", 3, 0.8, { w: 0.15, h: 0.06 })];
  return {
    title: "Service Agreement: Kedai Runcit",
    roles: signerRole,
    fields,
    form: null,
    base: await textPdf(4),
    pageCount: 4,
    people: [{ role: "signer", name: "Ali bin Ahmad", email: "ali@kedairuncit.example" }],
    answers: (_d, who) => [
      { signer: who("signer"), key: "biz", value: { text: "Kedai Runcit Ali Sdn Bhd" } },
      { signer: who("signer"), key: "msig", value: { image: png, mime: "image/png" } },
      { signer: who("signer"), key: "agree", value: { checked: true } },
      { signer: who("signer"), key: "ini", value: { image: png, mime: "image/png" } },
    ],
    events: 12,
  };
}

/** The Merchant Application with a complete, made-up set of answers (the same ones merchant.test.ts prints), two signers. */
async function specB(): Promise<Spec> {
  const png = dataUrl(await scribblePng());
  const form = resolvedWithSystemLists(MERCHANT_FORM, ACCT);
  const SAMPLE: Record<string, StoredAnswer | { list: string[] }> = {
    legal_name: { text: "KEDAI RUNCIT CONTOH JAYA ENTERPRISE SDN. BHD. (FORMERLY CONTOH TRADING)" },
    trading_name: { text: "Kedai Contoh Jaya" },
    business_type: { text: "sdn_bhd" },
    brn_type: { text: "roc" },
    brn: { text: "202001000001" },
    einvoice_phase: { text: "phase_3" },
    tin: { text: "C0000000001" },
    tax_type: { text: "sst" },
    tax_percent: { text: "8" },
    sst_no: { text: "B16-0000-00000001" },
    msic_codes: { list: ["47111", "47211", "56101"] },
    business_activity: { text: "Retail of groceries and prepared food through one shop and an online store." },
    address: { text: "No. 1, Jalan Contoh 1/1, Taman Contoh Indah, Kawasan Perindustrian Contoh" },
    city: { text: "Petaling Jaya" },
    postcode: { text: "47800" },
    state: { text: "selangor" },
    country: { text: "MY" },
    company_phone: { text: "+60312345678" },
    contact_name: { text: "Contoh Binti Ahmad" },
    contact_designation: { text: "Pengurus Operasi" },
    contact_phone: { text: "+60123456789" },
    contact_email: { text: "contoh@example.test" },
    einv_pic_name: { text: "Ali Bin Contoh" },
    einv_pic_email: { text: "kewangan@example.test" },
    einvoice_email: { text: "einvoice@example.test" },
    bank_name: { text: "maybank" },
    bank_account: { text: "514000000001" },
    bank_holder: { text: "KEDAI RUNCIT CONTOH JAYA ENTERPRISE SDN. BHD." },
    bank_branch: { text: "Petaling Jaya" },
    bank_swift: { text: "MBBEMYKL" },
    finance_contact: { text: "Ali Bin Contoh" },
    terms_accepted: { checked: true },
    signer_designation: { text: "Pengarah" },
    company_stamp: { image: png, mime: "image/png" },
  };
  // the template as it was sent: the sender's fixed text is already on it
  const template = new Uint8Array(readFileSync(path.join(process.cwd(), "src", "lib", "sign", "addons", "merchant", "assets", "merchant-application.pdf")));
  const frozen = await freezeBase(template, MERCHANT_PLACEMENTS, { fw_no: "FW-0001" }, { locale: "en", timeZone: "Asia/Kuala_Lumpur" });
  const placed = answerFields(MERCHANT_PLACEMENTS).filter((p) => p.role === "merchant" || p.role === "director");
  return {
    title: "Merchant Application: Kedai Contoh Jaya",
    roles: MERCHANT_ROLES,
    fields: MERCHANT_PLACEMENTS,
    form,
    base: frozen.bytes,
    pageCount: 4,
    people: [
      { role: "merchant", name: "Contoh Binti Ahmad", email: "contoh@example.test" },
      { role: "director", name: "Pengarah Contoh", email: "director@example.test" },
    ],
    answers: (_d, who) => {
      const rows: ReturnType<Spec["answers"]> = [];
      for (const [key, value] of Object.entries(SAMPLE)) {
        const field = form.fields.find((x) => x.key === key) ?? null;
        // a list answer is stored as its own shape; the cast keeps the one StoredAnswer type for the plain ones
        rows.push({ signer: who("merchant"), key, value: value as StoredAnswer, field });
      }
      for (const p of placed) {
        if (p.type === "name" || p.type === "date_signed") continue;
        const value: StoredAnswer = p.type === "signature" || p.type === "initials" ? { image: png, mime: "image/png" } : p.type === "checkbox" ? { checked: true } : { text: "Sample" };
        rows.push({ signer: who(p.role), key: p.key, value });
      }
      return rows;
    },
    events: 14,
  };
}

/**
 * `fieldCount` fields spread over `pages` pages, a mix of every kind that is answered (a sixth each of text, multi-line text, name, signing
 * date, tick box, signature), one signer. With `overflow` the multi-line boxes are small and each answer is `overflow` characters long, so
 * the engine cannot fit it and searches every font size down to the smallest before cutting it (plain fields are not gated for fit at
 * signing, only form-bound ones are, so such an answer can reach the sealing job).
 */
async function specMany(pages: number, fieldCount: number, opts: { big?: boolean; overflow?: number } = {}): Promise<Spec> {
  const image = dataUrl(opts.big ? await largestPng() : await scribblePng());
  const kinds: PlacedField["type"][] = ["text", "text", "name", "date_signed", "checkbox", "signature"];
  const perPage = Math.ceil(fieldCount / pages);
  const fields: PlacedField[] = [];
  for (let i = 0; i < fieldCount; i++) {
    const page = Math.floor(i / perPage);
    const slot = i % perPage;
    const type = kinds[i % kinds.length];
    const multiline = type === "text" && i % kinds.length === 1;
    const fits = !opts.overflow;
    fields.push({ key: `f${i}`, type, role: "signer", page, x: 0.1, y: 0.05 + (slot * 0.9) / Math.max(perPage, 1), w: type === "checkbox" ? 0.03 : multiline && fits ? 0.8 : 0.5, h: type === "signature" ? 0.06 : multiline && fits ? 0.05 : 0.035, required: true, multiline });
  }
  const sentence = "A note that wraps over several lines inside the box on the page so the fitting code has to work. ";
  const note = opts.overflow ? sentence.repeat(Math.ceil(opts.overflow / sentence.length)).slice(0, opts.overflow) : sentence.trim();
  return {
    title: `Long agreement (${pages} pages, ${fieldCount} fields)`,
    roles: signerRole,
    fields,
    form: null,
    base: await textPdf(pages),
    pageCount: pages,
    people: [{ role: "signer", name: "Ali bin Ahmad", email: "ali@kedairuncit.example" }],
    answers: (_d, who) => {
      const out: ReturnType<Spec["answers"]> = [];
      for (const f of fields) {
        const signer = who("signer");
        if (f.type === "text") out.push({ signer, key: f.key, value: { text: f.multiline ? note : "Kedai Runcit Ali Sdn Bhd" } });
        else if (f.type === "checkbox") out.push({ signer, key: f.key, value: { checked: true } });
        else if (f.type === "signature") out.push({ signer, key: f.key, value: { image, mime: "image/png" } });
      }
      return out;
    },
    events: pages > 100 ? 60 : 40,
  };
}

async function specFor(name: string): Promise<Spec> {
  const base = name.replace(/^loop-/, "");
  if (base === "a") return specA();
  if (base === "b") return specB();
  if (base === "c") return specMany(50, MAX_FIELDS);
  if (base === "c-overflow") return specMany(50, MAX_FIELDS, { overflow: 330 });
  if (base === "c-overflow-max") return specMany(50, MAX_FIELDS, { overflow: 2000 });
  if (base === "c-max") return specMany(50, MAX_FIELDS, { big: true });
  if (base === "d") return specMany(Number(process.env.SEAL_BENCH_DPAGES ?? 190), MAX_FIELDS);
  throw new Error(`unknown scenario ${name}`);
}

// ---- measuring --------------------------------------------------------------------------------------------------------

/** Samples the process RSS from a worker thread, so a long synchronous stretch of the engine is still seen. `lap()` returns the peak since the last lap. */
function startRssSampler() {
  const code = `const { parentPort } = require("node:worker_threads");
let peak = 0;
const sample = () => { const r = process.memoryUsage.rss(); if (r > peak) peak = r; };
const t = setInterval(sample, 2);
parentPort.on("message", (m) => { sample(); if (m === "lap") { parentPort.postMessage(peak); peak = 0; } else if (m === "stop") { clearInterval(t); parentPort.postMessage(peak); } });`;
  const worker = new Worker(code, { eval: true });
  const ask = (m: "lap" | "stop") => new Promise<number>((resolve) => { worker.once("message", resolve); worker.postMessage(m); });
  return { lap: () => ask("lap"), stop: async () => { const p = await ask("stop"); await worker.terminate(); return p; } };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function child(name: string, reps: number, batch: number): Promise<ScenarioResult> {
  const loop = name.startsWith("loop-");
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) throw new Error("run with node --expose-gc");
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" ").slice(0, 300));

  const spec = await specFor(name);
  const db = new FakeDb();
  const counters: Counters = { queries: 0, rpcs: 0, storage: 0, emails: 0 };
  let peakHeap = 0;
  let peakExternal = 0;
  const sample = () => {
    const h = v8.getHeapStatistics().used_heap_size;
    const e = process.memoryUsage().external;
    if (h > peakHeap) peakHeap = h;
    if (e > peakExternal) peakExternal = e;
  };
  const deps: NotifyDeps = { emailConfigured: () => true, sendEmail: async () => void counters.emails++, loadIdentity: async () => ({ fromName: "Vircle" }), sendWhatsApp: async () => {} };
  const admin = counted(db, counters, sample);
  const base = { admin, origin: "https://halo.test", deps, now: () => new Date() };

  // the workspace: a certificate made the way the service makes the first one (2048-bit RSA, encrypted), settings, a sender
  const p12b64 = process.env.SEAL_BENCH_P12 ?? Buffer.from(createSelfSignedP12({ commonName: "Vircle (Halo Doc Sign)", passphrase: "bench-passphrase", years: 5 })).toString("base64");
  db.seed("accounts", [{ id: ACCT, name: "Vircle Sdn Bhd", brand_name: null, timezone: "Asia/Kuala_Lumpur" }]);
  db.seed("profiles", [{ user_id: USER, account_id: ACCT, full_name: "Gokula", email: "gokula@vircle.example" }]);
  db.seed("sign_settings", [{ id: "set1", account_id: ACCT, default_expiry_days: 14, reminder_days: [3, 7], default_language: "en", consent_texts: {}, sender_name: null, retention_years: 7, certificate_id: null, whatsapp_template_name: null, whatsapp_template_language: "en" }]);
  db.seed("account_platform", [{ account_id: ACCT, status: "active", features: { sign: true }, limits: {} }]);
  db.seed("sign_certificates", [{ id: "cert1", account_id: ACCT, name: "Halo self-signed (not trusted by PDF readers)", source: "generated", p12_enc: encrypt(p12b64), passphrase_enc: encrypt(process.env.SEAL_BENCH_PASS ?? "bench-passphrase"), valid_until: null, is_default: true }]);

  // the database functions sealing calls, as small as the service tests make them
  const finals = new Map<string, string>();
  db.rpcHandlers.sign_claim_sealing = async (a) => {
    const rows = db.rows("sign_documents").filter((d) => d.status === "sealing" && !d.sealing_started_at).slice(0, Math.max(Number(a.p_limit), 1));
    for (const r of rows) Object.assign(r, { sealing_started_at: new Date().toISOString(), sealing_attempts: Number(r.sealing_attempts) + 1 });
    return { data: rows.map((r) => ({ document_id: r.id, account_id: r.account_id })), error: null };
  };
  db.rpcHandlers.sign_finish_sealing = async (a) => {
    const d = db.rows("sign_documents").find((x) => x.id === a.p_document)!;
    Object.assign(d, { status: "completed", final_path: a.p_final_path, final_sha256: a.p_final_sha256 });
    finals.set(String(a.p_document), String(a.p_final_path));
    return { data: {}, error: null };
  };
  db.rpcHandlers.sign_fail_sealing = async (a) => {
    errors.push(`sign_fail_sealing: ${String(a.p_error)}`);
    return { data: null, error: null };
  };
  db.rpcHandlers.sign_log = async () => ({ data: null, error: null });
  db.rpcHandlers.sign_ensure_defaults = async () => ({ data: null, error: null });

  const documents = loop ? batch : reps + 1;
  for (let i = 1; i <= documents; i++) seedDocument(db, spec, i);
  const inputBytes = spec.base.byteLength;

  // baseline: everything set up, collected
  gc();
  gc();
  const mem0 = process.memoryUsage();
  const heap0 = v8.getHeapStatistics().used_heap_size;
  peakHeap = heap0;
  peakExternal = mem0.external;
  const sampler = startRssSampler();
  await sampler.lap();
  const ticker = setInterval(sample, 5);
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();

  counters.queries = counters.rpcs = counters.storage = counters.emails = 0;
  const runsMs: number[] = [];
  const peaks: number[] = [];
  let loopInfo: ScenarioResult["loop"];
  if (!loop) {
    for (let i = 0; i < documents; i++) {
      const t0 = performance.now();
      const out = await runSealing(base, 1);
      runsMs.push(performance.now() - t0);
      peaks.push(await sampler.lap());
      if (out.completed !== 1) throw new Error(`seal ${i + 1} did not complete: ${JSON.stringify(out)} ${errors.join(" | ")}`);
    }
  } else {
    const tickMs: number[] = [];
    const perTick = 2; // what runAll in src/lib/sign/service/jobs.ts passes: runSealing(base, 2)
    let done = 0;
    const t0 = performance.now();
    for (;;) {
      const t1 = performance.now();
      const out = await runSealing(base, perTick);
      if (out.claimed === 0) break;
      tickMs.push(performance.now() - t1);
      done += out.completed;
      if (out.retry) throw new Error(`a seal did not complete: ${errors.join(" | ")}`);
    }
    const totalMs = performance.now() - t0;
    peaks.push(await sampler.lap());
    if (done !== documents) throw new Error(`only ${done} of ${documents} were sealed`);
    loopInfo = { documents, ticks: tickMs.length, perTick, totalMs, tickMs };
    runsMs.push(totalMs);
  }
  clearInterval(ticker);
  loopDelay.disable();
  sample();
  const callsPerDoc = { queries: counters.queries / documents, rpcs: counters.rpcs / documents, storage: counters.storage / documents, emails: counters.emails / documents };
  await sampler.stop();

  // what was written must be a real, valid sealed file
  const finalPath = [...finals.values()][0];
  const final = db.files.get(finalPath)!;
  const v = verifySealed(final);
  gc();
  gc();
  const after = process.memoryUsage();
  console.error = realError;

  return {
    scenario: name,
    title: spec.title,
    pages: spec.pageCount,
    fields: spec.fields.length,
    boundFields: spec.fields.filter((f) => f.data).length,
    signers: spec.people.length,
    inputBytes,
    outputBytes: final.byteLength,
    outputPages: (await PDFDocument.load(final, { updateMetadata: false })).getPageCount(),
    runsMs,
    peakRssMb: peaks.map(mb),
    baselineRssMb: mb(mem0.rss),
    peakHeapMb: mb(peakHeap),
    baselineHeapMb: mb(heap0),
    peakExternalMb: mb(peakExternal),
    baselineExternalMb: mb(mem0.external),
    eventLoopMaxMs: Math.round((loopDelay.max / 1e6 - 10) * 10) / 10,
    eventLoopP99Ms: Math.round((loopDelay.percentile(99) / 1e6 - 10) * 10) / 10,
    retainedRssMb: mb(after.rss),
    retainedHeapMb: mb(after.heapUsed),
    callsPerDoc: { queries: Math.round(callsPerDoc.queries), rpcs: Math.round(callsPerDoc.rpcs), storage: Math.round(callsPerDoc.storage), emails: Math.round(callsPerDoc.emails) },
    loop: loopInfo,
    sealVerified: v.ok && v.problems.length === 0,
    errors,
  };
}

// ---- the parent -------------------------------------------------------------------------------------------------------

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function machine() {
  const cpus = os.cpus();
  return { platform: `${os.type()} ${os.release()} (${os.arch()})`, cpu: cpus[0]?.model.trim() ?? "unknown", logicalCores: cpus.length, ramGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10, node: process.version };
}

const fmt = (n: number) => (n >= 100 ? Math.round(n).toString() : (Math.round(n * 10) / 10).toString());

function parent() {
  const only = arg("only", "a,b,c,c-overflow,c-overflow-max,c-max,d,loop-a,loop-b").split(",").map((s) => s.trim()).filter(Boolean);
  const reps = Number(arg("reps", "5"));
  const batch = Number(arg("batch", "200"));
  const jsonOut = process.argv.includes("--json") ? arg("json", "") : "";
  const script = process.argv[1];
  const info = machine();
  console.log(`Doc Sign sealing benchmark on ${info.cpu} (${info.logicalCores} logical cores, ${info.ramGb} GB RAM), Node ${info.node}, ${info.platform}`);
  console.log("Developer machine, real PDF engine, FakeDb for the database and storage (no network time). NOT the live server.\n");

  // one certificate for every child: key generation is slow and is not what is being measured
  const pass = "bench-passphrase";
  const p12 = Buffer.from(createSelfSignedP12({ commonName: "Vircle (Halo Doc Sign)", passphrase: pass, years: 5 })).toString("base64");
  const env = { ...process.env, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? "ab".repeat(32), SEAL_BENCH_P12: p12, SEAL_BENCH_PASS: pass };

  const results: ScenarioResult[] = [];
  for (const name of only) {
    const run = spawnSync(process.execPath, ["--expose-gc", script, "--child", name, "--reps", String(name === "c-overflow-max" ? 0 : name === "c-overflow" ? Math.min(reps, 1) : reps), "--batch", String(batch)], { env, encoding: "utf8", maxBuffer: 64 * MB });
    const line = (run.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("RESULT "));
    if (run.status !== 0 || !line) {
      console.error(`scenario ${name} failed (exit ${run.status}):\n${run.stderr}\n${run.stdout}`);
      process.exitCode = 1;
      continue;
    }
    const r = JSON.parse(line.slice(7)) as ScenarioResult;
    results.push(r);
    console.log(`${name}: done`);
  }

  console.log("\nSingle seal job (one document claimed and sealed, stored, read back, verified, completed, mails handed to a no-op sender):");
  console.log("scenario | pages | fields (bound) | signers | input KB | output KB (pages) | cold ms | warm median ms | warm min-max ms | peak RSS MB (cold / worst) | cold RSS growth MB | peak heapUsed MB | peak external MB | event loop stall max / p99 ms | seal valid");
  for (const r of results.filter((x) => !x.loop)) {
    const warm = r.runsMs.length > 1 ? r.runsMs.slice(1) : r.runsMs; // a scenario that is too slow to repeat has its one cold run only
    console.log([r.scenario, r.pages, `${r.fields} (${r.boundFields})`, r.signers, Math.round(r.inputBytes / 1024), `${Math.round(r.outputBytes / 1024)} (${r.outputPages} pp)`, fmt(r.runsMs[0]), fmt(median(warm)), `${fmt(Math.min(...warm))}-${fmt(Math.max(...warm))}`, `${r.peakRssMb[0]} / ${Math.max(...r.peakRssMb)}`, fmt(r.peakRssMb[0] - r.baselineRssMb), r.peakHeapMb, r.peakExternalMb, `${fmt(r.eventLoopMaxMs)} / ${fmt(r.eventLoopP99Ms)}`, r.sealVerified ? "yes" : "NO"].join(" | "));
  }
  console.log("\nCron batch loop (runSealing(base, 2) called until nothing is left, as runAll does once a minute):");
  for (const r of results.filter((x) => x.loop)) {
    const l = r.loop!;
    const perDoc = l.totalMs / l.documents;
    console.log(`${r.scenario}: ${l.documents} documents, ${l.ticks} ticks of ${l.perTick}, total ${fmt(l.totalMs)} ms, ${fmt(perDoc)} ms per document, tick median ${fmt(median(l.tickMs))} ms (max ${fmt(Math.max(...l.tickMs))}), peak RSS ${r.peakRssMb[0]} MB (growth ${fmt(r.peakRssMb[0] - r.baselineRssMb)}), retained RSS after gc ${r.retainedRssMb} MB, ${fmt(60_000 / perDoc)} docs/minute of pure engine time, seal valid: ${r.sealVerified ? "yes" : "NO"}`);
  }
  const noisy = results.filter((r) => r.errors.length);
  for (const r of noisy) console.log(`\n${r.scenario}: ${r.errors.length} console.error line(s), first: ${r.errors[0]}`);
  console.log("\nCalls per seal job (each is a network round trip on the live server, not included above):");
  for (const r of results) console.log(`${r.scenario}: ${r.callsPerDoc.queries} table queries, ${r.callsPerDoc.rpcs} rpcs, ${r.callsPerDoc.storage} storage calls, ${r.callsPerDoc.emails} mails`);
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ machine: info, node: process.version, results }, null, 2));
    console.log(`\nresults written to ${jsonOut}`);
  }
}

if (process.argv.includes("--child")) {
  const name = arg("child", "");
  child(name, Number(arg("reps", "5")), Number(arg("batch", "200")))
    .then((r) => {
      process.stdout.write(`RESULT ${JSON.stringify(r)}\n`);
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(1);
    });
} else {
  parent();
}
