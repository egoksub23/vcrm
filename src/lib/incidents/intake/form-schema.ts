// The coach report as data. One format drives the phone page, the server-side check of what was submitted, and (Phase 3) the drag-and-drop builder.
// Labels are language maps ({"en": ...}) from the start, so Malay and Chinese are added later without a data change.

import { labelOf, type LangMap } from "@/lib/incidents/platform/roles";

export type FieldType = "involved" | "choice" | "text" | "longtext" | "yesno" | "photo";

/** How bad it was, in the coach's words. Mapped onto the school's own severity scale (most serious level at the top). */
export const SEVERITY_BANDS = ["minor", "first_aid", "cannot_continue", "hospital"] as const;
export type SeverityBand = (typeof SEVERITY_BANDS)[number];

export interface Effects {
  /** The category code the report is filed under. */
  category?: string;
  flags?: string[];
  band?: SeverityBand;
}

export interface ChoiceOption {
  value: string;
  label: LangMap;
  help?: LangMap;
  effects?: Effects;
}

export interface Condition {
  field: string;
  equals?: string;
  in?: string[];
}

export interface FormField {
  key: string;
  type: FieldType;
  label: LangMap;
  help?: LangMap;
  required?: boolean;
  options?: ChoiceOption[];
  showIf?: Condition;
  maxLength?: number;
  /** yesno only: the effects when the answer is yes. */
  ifYes?: Effects;
}

export interface FormStep {
  key: string;
  title: LangMap;
  fields: FormField[];
}

export interface FormSchema {
  version: 1;
  id: string;
  steps: FormStep[];
}

export interface InvolvedAnswer {
  /** Roster ids the coach ticked. */
  ids: string[];
  /** Names typed for someone not on the roster (a visitor, another school's student). */
  others: string[];
}

export type Answers = Record<string, unknown>;

export interface RosterEntry {
  student_id: string;
  name: string;
  class?: string;
  guardians?: { name?: string; email?: string; phone?: string }[];
}

// ---- the built-in CCA form --------------------------------------------------------------------------------------

export const CCA_FORM: FormSchema = {
  version: 1,
  id: "cca",
  steps: [
    {
      key: "who",
      title: { en: "Who was involved?", ms: "Siapa yang terlibat?", zh: "谁牵涉其中？" },
      fields: [{ key: "involved", type: "involved", label: { en: "Who was involved?", ms: "Siapa yang terlibat?", zh: "谁牵涉其中？" }, help: { en: "Tap everyone who was hurt or involved.", ms: "Ketik semua orang yang cedera atau terlibat.", zh: "点选所有受伤或牵涉其中的人。" }, required: true }],
    },
    {
      key: "what",
      title: { en: "What happened?", ms: "Apa yang berlaku?", zh: "发生了什么？" },
      fields: [
        {
          key: "kind",
          type: "choice",
          label: { en: "What kind of incident was it?", ms: "Apakah jenis insiden ini?", zh: "这是哪一类事件？" },
          required: true,
          options: [
            { value: "injury", label: { en: "Injury", ms: "Kecederaan", zh: "受伤" }, help: { en: "Someone was hurt during the activity", ms: "Seseorang cedera semasa aktiviti", zh: "活动期间有人受伤" }, effects: { category: "CCA", flags: ["injury", "child_involved"] } },
            { value: "near_miss", label: { en: "Near miss", ms: "Hampir berlaku", zh: "险些发生" }, help: { en: "Nobody was hurt, but it could have been", ms: "Tiada yang cedera, tetapi boleh jadi", zh: "没有人受伤，但差一点" }, effects: { category: "NMS" } },
            { value: "damage", label: { en: "Damage or loss", ms: "Kerosakan atau kehilangan", zh: "损坏或遗失" }, help: { en: "Equipment or property", ms: "Peralatan atau harta benda", zh: "器材或财物" }, effects: { category: "PRD", flags: ["property_damage"] } },
            { value: "other", label: { en: "Something else", ms: "Perkara lain", zh: "其他" }, help: { en: "Behaviour, safety, anything else", ms: "Tingkah laku, keselamatan, apa-apa lagi", zh: "行为、安全或其他事项" }, effects: { category: "OTH" } },
          ],
        },
        { key: "what", type: "longtext", label: { en: "Tell us what happened", ms: "Ceritakan apa yang berlaku", zh: "请说明发生了什么" }, help: { en: "A sentence or two is enough. Leave names out; you already chose them.", ms: "Satu atau dua ayat sudah cukup. Tidak perlu nama; anda sudah memilihnya.", zh: "一两句话就够了。不用写名字，您已经选好了。" }, required: true, maxLength: 1000 },
      ],
    },
    {
      key: "how",
      title: { en: "How serious?", ms: "Sejauh mana serius?", zh: "有多严重？" },
      fields: [
        {
          key: "severity",
          type: "choice",
          label: { en: "How serious was it?", ms: "Sejauh mana seriusnya?", zh: "严重程度如何？" },
          required: true,
          options: [
            { value: "minor", label: { en: "Minor", ms: "Ringan", zh: "轻微" }, help: { en: "A plaster or a rest was enough", ms: "Plaster atau berehat sudah mencukupi", zh: "贴个创可贴或休息一下就够了" }, effects: { band: "minor" } },
            { value: "first_aid", label: { en: "Needs first aid or the nurse", ms: "Perlu pertolongan cemas atau jururawat", zh: "需要急救或校医" }, effects: { band: "first_aid" } },
            { value: "cannot_continue", label: { en: "Could not continue", ms: "Tidak dapat meneruskan", zh: "无法继续" }, effects: { band: "cannot_continue" } },
            { value: "hospital", label: { en: "Needs a doctor or hospital", ms: "Perlu doktor atau hospital", zh: "需要看医生或送医院" }, effects: { band: "hospital" } },
          ],
        },
        {
          key: "body_part",
          type: "choice",
          label: { en: "Where was the injury?", ms: "Di mana kecederaan itu?", zh: "伤在哪里？" },
          showIf: { field: "kind", equals: "injury" },
          options: [
            { value: "head", label: { en: "Head or face", ms: "Kepala atau muka", zh: "头部或脸部" } },
            { value: "arm", label: { en: "Arm or hand", ms: "Lengan atau tangan", zh: "手臂或手" } },
            { value: "leg", label: { en: "Leg or foot", ms: "Kaki", zh: "腿或脚" } },
            { value: "back", label: { en: "Back or neck", ms: "Belakang atau leher", zh: "背部或颈部" } },
            { value: "other", label: { en: "Somewhere else", ms: "Tempat lain", zh: "其他部位" } },
          ],
        },
        {
          key: "head_injury",
          type: "yesno",
          label: { en: "Did the student hit their head, or seem dazed or confused?", ms: "Adakah pelajar terhantuk kepala, atau kelihatan pening atau keliru?", zh: "学生是否撞到头部，或看起来头晕、糊涂？" },
          help: { en: "If yes, the school nurse is told straight away.", ms: "Jika ya, jururawat sekolah dimaklumkan serta-merta.", zh: "如果是，会立即通知校医。" },
          showIf: { field: "kind", equals: "injury" },
          ifYes: { flags: ["concussion"], band: "cannot_continue" },
        },
        { key: "photo", type: "photo", label: { en: "Add a photo (optional)", ms: "Tambah gambar (pilihan)", zh: "添加照片（可选）" }, help: { en: "Of the area or equipment. Not of a child's injury.", ms: "Kawasan atau peralatan sahaja. Bukan kecederaan kanak-kanak.", zh: "拍摄场地或器材，请勿拍摄孩子的伤势。" } },
      ],
    },
  ],
};

// ---- visibility and validation ----------------------------------------------------------------------------------

function holds(cond: Condition | undefined, answers: Answers): boolean {
  if (!cond) return true;
  const v = answers[cond.field];
  if (cond.equals !== undefined) return v === cond.equals;
  if (cond.in) return typeof v === "string" && cond.in.includes(v);
  return true;
}

export function visibleFields(step: FormStep, answers: Answers): FormField[] {
  return step.fields.filter((f) => holds(f.showIf, answers));
}

export function allVisibleFields(schema: FormSchema, answers: Answers): FormField[] {
  return schema.steps.flatMap((s) => visibleFields(s, answers));
}

const isInvolved = (v: unknown): v is InvolvedAnswer =>
  typeof v === "object" && v !== null && Array.isArray((v as InvolvedAnswer).ids) && Array.isArray((v as InvolvedAnswer).others);

/** Plain-words problems per field key. Empty when the answers are good. `roster` is the list the portal sent for this link. */
export function validateAnswers(schema: FormSchema, answers: Answers, roster: readonly RosterEntry[]): Record<string, string> {
  const problems: Record<string, string> = {};
  const known = new Set(roster.map((r) => r.student_id));
  for (const f of allVisibleFields(schema, answers)) {
    const v = answers[f.key];
    switch (f.type) {
      case "involved": {
        const a = isInvolved(v) ? v : { ids: [], others: [] };
        const ids = a.ids.filter((x): x is string => typeof x === "string");
        const others = a.others.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
        if (ids.some((id) => !known.has(id))) problems[f.key] = "Someone chosen is not on this activity's list.";
        else if (others.some((o) => o.trim().length > 80)) problems[f.key] = "A typed name is too long.";
        else if (f.required && ids.length + others.length === 0) problems[f.key] = "Choose at least one person.";
        else if (ids.length + others.length > 50) problems[f.key] = "Too many people chosen.";
        break;
      }
      case "choice": {
        const valid = (f.options ?? []).some((o) => o.value === v);
        if (v === undefined || v === null || v === "") {
          if (f.required) problems[f.key] = "Choose one.";
        } else if (!valid) problems[f.key] = "That choice is not available.";
        break;
      }
      case "text":
      case "longtext": {
        const s = typeof v === "string" ? v.trim() : "";
        if (f.required && !s) problems[f.key] = "This is needed.";
        else if (s.length > (f.maxLength ?? (f.type === "text" ? 200 : 2000))) problems[f.key] = "That is too long.";
        break;
      }
      case "yesno":
        if (v !== undefined && v !== null && typeof v !== "boolean") problems[f.key] = "Answer yes or no.";
        else if (f.required && typeof v !== "boolean") problems[f.key] = "Answer yes or no.";
        break;
      case "photo":
        break; // photos are uploaded separately, after the report is sent
    }
  }
  return problems;
}

// ---- turning answers into an incident ---------------------------------------------------------------------------

export interface TemplateScale {
  /** Categories that exist in the school's active template. */
  categoryCodes: readonly string[];
  /** The template's severity levels. */
  severities: readonly { slug: string; position: number }[];
}

/** Which of the school's severity levels a band means. The scale is read most-serious-first (position 0); a short scale spreads the four bands across it. */
export function severityForBand(band: SeverityBand, severities: readonly { slug: string; position: number }[]): string | null {
  const levels = [...severities].sort((a, b) => b.position - a.position); // least serious first
  if (levels.length === 0) return null;
  const rank = SEVERITY_BANDS.indexOf(band); // 0 minor .. 3 hospital
  const idx = Math.round((rank / (SEVERITY_BANDS.length - 1)) * (levels.length - 1));
  return levels[idx].slug;
}

export interface DerivedIncident {
  category: string;
  severity: string;
  flags: string[];
  description: string;
  involved: { studentId: string | null; name: string; className: string | null; guardians: NonNullable<RosterEntry["guardians"]> }[];
  kindLabel: string;
  bandWord: SeverityBand;
}

export type DeriveResult = { ok: true; incident: DerivedIncident } | { ok: false; error: string };

/**
 * What the report means for Halo: the category, the severity on the school's scale, the flags (injury, child involved, concussion ...) and the people.
 * Fails (rather than guessing) when the school's template does not have the categories the form files under: the portal form needs the School template.
 */
export function deriveIncident(schema: FormSchema, answers: Answers, roster: readonly RosterEntry[], scale: TemplateScale): DeriveResult {
  const effects: Effects[] = [];
  for (const f of allVisibleFields(schema, answers)) {
    const v = answers[f.key];
    if (f.type === "choice") {
      const opt = (f.options ?? []).find((o) => o.value === v);
      if (opt?.effects) effects.push(opt.effects);
    } else if (f.type === "yesno" && v === true && f.ifYes) {
      effects.push(f.ifYes);
    }
  }
  const category = effects.map((e) => e.category).find(Boolean);
  if (!category) return { ok: false, error: "The report does not say what kind of incident it was." };
  if (!scale.categoryCodes.includes(category)) return { ok: false, error: `The school's template has no category "${category}", so this report form cannot be used with it.` };

  // The most serious band any answer asks for wins (a head injury raises the band whatever was ticked).
  const bands = effects.map((e) => e.band).filter((b): b is SeverityBand => Boolean(b));
  const band = bands.sort((a, b) => SEVERITY_BANDS.indexOf(b) - SEVERITY_BANDS.indexOf(a))[0] ?? "minor";
  const severity = severityForBand(band, scale.severities);
  if (!severity) return { ok: false, error: "The school's template has no severity levels." };

  const flags = [...new Set(effects.flatMap((e) => e.flags ?? []))];

  const a = isInvolved(answers.involved) ? answers.involved : { ids: [], others: [] };
  const byId = new Map(roster.map((r) => [r.student_id, r]));
  const involved: DerivedIncident["involved"] = [];
  for (const id of new Set(a.ids)) {
    const r = byId.get(id);
    if (r) involved.push({ studentId: r.student_id, name: r.name, className: r.class ?? null, guardians: r.guardians ?? [] });
  }
  for (const other of a.others) {
    const name = other.trim();
    if (name) involved.push({ studentId: null, name, className: null, guardians: [] });
  }

  const kindField = allVisibleFields(schema, answers).find((f) => f.key === "kind");
  const kindLabel = labelOf(kindField?.options?.find((o) => o.value === answers.kind)?.label);
  const description = typeof answers.what === "string" ? answers.what.trim() : "";
  return { ok: true, incident: { category, severity, flags, description, involved, kindLabel, bandWord: band } };
}
