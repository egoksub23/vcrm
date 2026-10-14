import { describe, expect, it } from "vitest";

import type { AnswerMap, DataField, FormDefinition } from "../forms/types";
import { checkImageDataUrl } from "./signer-images";
import {
  STAMP_FILE_NAME,
  STAMP_INK,
  STAMP_SIZE,
  bracketed,
  canMakeStamp,
  cleanStampName,
  cleanStampNumber,
  dataUrlToFile,
  fitName,
  initialStampWay,
  stampCardState,
  stampDataUrl,
  stampInputs,
  stampIsStale,
  stampSignature,
  stampSvg,
  textWidth,
  xmlEscape,
} from "./stamp";

const NEW = "202101012345";
const OLD = "123456-A";

describe("the stamp drawing (an SVG string, no browser)", () => {
  const svg = stampSvg({ name: "Kedai Runcit Ali Sdn. Bhd.", newNumber: NEW, oldNumber: OLD });

  it("is a 600 x 600 picture with nothing behind it, in dark blue ink", () => {
    expect(STAMP_SIZE).toBe(600);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('width="600" height="600" viewBox="0 0 600 600"');
    // no background shape: nothing is filled but the ink
    expect(svg).not.toMatch(/<rect/);
    expect(svg).not.toMatch(/fill="(?!none|#2b2f8f)/);
    expect(STAMP_INK).toBe("#2b2f8f");
    expect(svg.match(/#2b2f8f/g)!.length).toBeGreaterThanOrEqual(5);
  });

  it("has an outer circle, a thin ring, an inner circle, the name on a path, two inner lines and a star", () => {
    expect(svg.match(/<circle /g)).toHaveLength(3);
    expect(svg).toContain('<path id="stamp-arc"');
    expect(svg).toMatch(/<textPath href="#stamp-arc" xlink:href="#stamp-arc"[^>]*>KEDAI RUNCIT ALI SDN\. BHD\.<\/textPath>/);
    expect(svg).toContain(`>${NEW}</text>`);
    expect(svg).toContain(`>(${OLD})</text>`);
    // the star: ten points, at the bottom centre of the ring
    const star = /<polygon points="([^"]+)"/.exec(svg)![1].split(" ");
    expect(star).toHaveLength(10);
    const ys = star.map((p) => Number(p.split(",")[1]));
    expect(Math.min(...ys)).toBeGreaterThan(450);
    const xs = star.map((p) => Number(p.split(",")[0]));
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(300, 0);
  });

  it("puts the new number on the first line, larger, and the old one in brackets under it", () => {
    const size = (text: string) => Number(new RegExp(`font-size="(\\d+)"[^>]*>${text.replace(/[()]/g, "\\$&")}</text>`).exec(svg)![1]);
    const y = (text: string) => Number(new RegExp(`y="([\\d.]+)"[^>]*>${text.replace(/[()]/g, "\\$&")}</text>`).exec(svg)![1]);
    expect(size(NEW)).toBeGreaterThan(size(`(${OLD})`));
    expect(y(`(${OLD})`)).toBeGreaterThan(y(NEW));
  });

  it("is the same string for the same input, and different for different input", () => {
    expect(stampSvg({ name: "Kedai Runcit Ali Sdn. Bhd.", newNumber: NEW, oldNumber: OLD })).toBe(svg);
    expect(stampSvg({ name: "Kedai Runcit Ali Sdn. Bhd.", newNumber: NEW, oldNumber: "(123456-a)" })).toBe(svg);
    expect(stampSvg({ name: "Kedai Runcit Ali Sdn. Bhd.", newNumber: NEW })).not.toBe(svg);
  });

  it("capitalises the name and leaves the old line out, centring the number, when there is no old number", () => {
    const plain = stampSvg({ name: "abc enterprise", newNumber: NEW });
    expect(plain).toContain(">ABC ENTERPRISE</textPath>");
    expect(plain).not.toContain("(");
    expect(plain).toContain('y="');
    for (const none of ["", "  ", "()", " ( ) "]) expect(stampSvg({ name: "x", newNumber: NEW, oldNumber: none })).toBe(stampSvg({ name: "x", newNumber: NEW }));
    // one inner line only: its centre is the middle of the stamp
    expect((plain.match(/text-anchor="middle"/g) ?? []).length).toBe(1);
    expect((svg.match(/text-anchor="middle"/g) ?? []).length).toBe(2);
  });

  it("escapes the name and the numbers, so no text can add markup", () => {
    const nasty = stampSvg({ name: `A<B> & "C" 'D' </text><script>alert(1)</script>`, newNumber: `1&2<3`, oldNumber: `"><x>` });
    expect(nasty).not.toContain("<script");
    expect(nasty).not.toContain("<x>");
    expect(nasty).toContain("A&lt;B&gt; &amp; &quot;C&quot; &apos;D&apos; &lt;/TEXT&gt;&lt;SCRIPT&gt;ALERT(1)&lt;/SCRIPT&gt;");
    expect(nasty).toContain("1&amp;2&lt;3");
    // it is still well formed: every tag opened is closed, and the only elements are ours
    const tags = [...nasty.matchAll(/<\/?([a-zA-Z]+)/g)].map((m) => m[1]);
    expect(new Set(tags)).toEqual(new Set(["svg", "title", "g", "circle", "defs", "path", "text", "textPath", "polygon"]));
    expect(xmlEscape(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
  });

  it("removes control characters and line breaks (a legal name field can have several lines)", () => {
    expect(cleanStampName("  Kedai\nRuncit\t Ali \u0000\u0007 ")).toBe("KEDAI RUNCIT ALI");
    expect(stampSvg({ name: "A\u0000B\nC", newNumber: "1\u00072" })).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    expect(cleanStampNumber(" 2021 0101 2345 ")).toBe(NEW);
    expect(bracketed("(abc-1)")).toBe("(ABC-1)");
    expect(bracketed("abc-1")).toBe("(ABC-1)");
    expect(bracketed("")).toBe("");
  });

  it("makes the letters smaller for a long name, so up to about 60 characters fit the arc, and never below the smallest size", () => {
    const sizes = ["AB SDN BHD", "KEDAI RUNCIT ALI SDN. BHD.", "ABC ENGINEERING & TRADING SERVICES (MALAYSIA) SDN. BHD.", "X".repeat(60), "ABCDEFGHIJ ".repeat(20)].map((n) => fitName(n));
    for (let i = 1; i < sizes.length; i++) expect(sizes[i].fontSize).toBeLessThanOrEqual(sizes[i - 1].fontSize);
    expect(sizes[0].fontSize).toBe(56);
    // about 60 characters: set at a readable size, laid on the arc with room to spare, not squeezed
    const sixty = fitName("ABC ENGINEERING & TRADING SERVICES (MALAYSIA) SDN. BHD. CAWANG");
    expect(sixty.squeezed).toBe(false);
    expect(sixty.fontSize).toBeGreaterThanOrEqual(20);
    expect(sixty.length).toBeLessThanOrEqual(sixty.arc);
    // far too long: the smallest size, squeezed to the arc rather than run into the star
    const huge = fitName("ABCDEFGHIJ ".repeat(20));
    expect(huge.fontSize).toBe(18);
    expect(huge.squeezed).toBe(true);
    expect(huge.length).toBeLessThanOrEqual(huge.arc);
    expect(stampSvg({ name: "ABCDEFGHIJ ".repeat(20), newNumber: NEW })).toContain('lengthAdjust="spacingAndGlyphs"');
    expect(stampSvg({ name: "KEDAI", newNumber: NEW })).toContain('lengthAdjust="spacing"');
  });

  it("centres the name on the top of the ring: its start offset is half of what is left of the arc", () => {
    const m = /startOffset="([\d.]+)" textLength="([\d.]+)"/.exec(svg)!;
    const fit = fitName("KEDAI RUNCIT ALI SDN. BHD.");
    expect(Number(m[2])).toBeCloseTo(fit.length, 1);
    expect(Number(m[1])).toBeCloseTo((fit.arc - fit.length) / 2, 1);
  });

  it("sets a Chinese, Japanese or Korean name smaller, in a generic sans-serif stack, and does not throw", () => {
    const zh = stampSvg({ name: "吉隆坡明华贸易有限公司", newNumber: NEW, oldNumber: OLD });
    expect(zh).toContain("吉隆坡明华贸易有限公司");
    expect(zh).toMatch(/font-family="[^"]*sans-serif"/);
    expect(fitName("吉隆坡明华贸易有限公司").fontSize).toBeLessThanOrEqual(44);
    expect(fitName("吉隆坡明华贸易有限公司").fontSize).toBeLessThanOrEqual(fitName("KEDAI RUNCIT").fontSize);
    // a wide character takes a whole em
    expect(textWidth("明", 10)).toBeGreaterThan(textWidth("M", 10));
    // mixed text, accents, emoji, an unpaired surrogate and an empty name all give a stamp
    for (const name of ["Kedai Café Ñandú 株式会社", "😀 Emoji Sdn Bhd", "\ud800 broken", "", "   ", "한국 상점"]) {
      expect(() => stampSvg({ name, newNumber: NEW })).not.toThrow();
      expect(stampSvg({ name, newNumber: NEW })).toContain("</svg>");
    }
  });

  it("gives a drawable stamp for any input, empty ones included", () => {
    for (const input of [{ name: "", newNumber: "" }, { name: "", newNumber: "", oldNumber: "(x)" }, { name: "A", newNumber: "9".repeat(200), oldNumber: "B".repeat(200) }]) {
      const out = stampSvg(input);
      expect(out.startsWith("<svg")).toBe(true);
      expect(out.endsWith("</svg>")).toBe(true);
    }
    // a name stops at 200 characters
    expect(cleanStampName("A".repeat(500))).toHaveLength(200);
  });

  it("can be shown as an image from a data URL", () => {
    const url = stampDataUrl(svg);
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice("data:image/svg+xml;charset=utf-8,".length))).toBe(svg);
  });
});

describe("what the stamp is made from", () => {
  const L = (en: string) => ({ en });
  const f = (key: string, over: Partial<DataField> = {}): DataField => ({ key, type: "text", part: "company", label: L(key), required: false, ...over });
  const form: FormDefinition = {
    version: 1,
    parts: [{ key: "company", title: L("Company"), role: "merchant" }, { key: "signing", title: L("Signing"), role: "merchant" }],
    fields: [
      f("legal_name", { type: "multiline" }),
      f("business_type", { type: "choice", options: [{ value: "sdn_bhd", label: L("Sdn. Bhd.") }, { value: "sole_prop", label: L("Sole") }] }),
      f("brn"),
      f("brn_old", { visibleIf: { op: "eq", field: "business_type", value: "sdn_bhd" } }),
      f("stamp", { type: "image", part: "signing", stamp: { nameField: "legal_name", newNumberField: "brn", oldNumberField: "brn_old" } }),
    ],
  };
  const source = form.fields[4].stamp!;
  const answers = (over: AnswerMap = {}): AnswerMap => ({ business_type: { text: "sdn_bhd" }, legal_name: { text: "Kedai Ali\nSdn. Bhd." }, brn: { text: NEW }, brn_old: { text: OLD }, ...over });

  it("reads the name, the number and the old number from the form's own answers", () => {
    const i = stampInputs(form, source, answers());
    expect(i).toEqual({ name: "KEDAI ALI SDN. BHD.", newNumber: NEW, oldNumber: OLD, missing: [], warnNumber: false });
    expect(canMakeStamp(i)).toBe(true);
  });

  it("says which detail is missing, name first, and makes no stamp until both are there", () => {
    expect(stampInputs(form, source, answers({ legal_name: undefined, brn: undefined })).missing).toEqual(["legal_name", "brn"]);
    expect(stampInputs(form, source, answers({ brn: undefined })).missing).toEqual(["brn"]);
    expect(stampInputs(form, source, answers({ legal_name: { text: "  " } })).missing).toEqual(["legal_name"]);
    expect(canMakeStamp(stampInputs(form, source, {}))).toBe(false);
    // the old number is never required
    expect(stampInputs(form, source, answers({ brn_old: undefined })).missing).toEqual([]);
  });

  it("ignores the answer to a field that is not shown (an old number given before the type of business changed)", () => {
    const i = stampInputs(form, source, answers({ business_type: { text: "sole_prop" } }));
    expect(i.oldNumber).toBe("");
    expect(i.missing).toEqual([]);
  });

  it("warns, without stopping, when the new number is not 12 digits", () => {
    expect(stampInputs(form, source, answers({ brn: { text: "12345" } })).warnNumber).toBe(true);
    expect(stampInputs(form, source, answers({ brn: { text: "12345" } })).missing).toEqual([]);
    expect(stampInputs(form, source, answers({ brn: { text: "20210101234A" } })).warnNumber).toBe(true);
    expect(stampInputs(form, source, answers()).warnNumber).toBe(false);
  });

  it("follows the answers as they change, and knows a stamp made earlier is out of date", () => {
    const a = stampInputs(form, source, answers());
    const made = stampSignature(a);
    expect(stampIsStale(null, a)).toBe(false);
    expect(stampIsStale(made, a)).toBe(false);
    expect(stampIsStale(made, stampInputs(form, source, answers({ legal_name: { text: "Another Sdn. Bhd." } })))).toBe(true);
    expect(stampIsStale(made, stampInputs(form, source, answers({ brn_old: { text: "999999-B" } })))).toBe(true);
    // spacing and case that the stamp does not show are not a change
    expect(stampIsStale(made, stampInputs(form, source, answers({ legal_name: { text: "kedai   ali sdn. bhd." } })))).toBe(false);
  });
});

describe("the card", () => {
  it("opens on the upload, always", () => {
    expect(initialStampWay()).toBe("upload");
  });

  it("is a list of what to fill in, then a live preview, then the saved stamp", () => {
    const missing = { missing: ["legal_name"] };
    const ready = { missing: [] as string[] };
    expect(stampCardState({ inputs: missing, created: false, replacing: false })).toBe("needs");
    expect(stampCardState({ inputs: ready, created: false, replacing: false })).toBe("preview");
    expect(stampCardState({ inputs: ready, created: true, replacing: false })).toBe("saved");
    // replacing goes back to the preview (or to what is missing)
    expect(stampCardState({ inputs: ready, created: true, replacing: true })).toBe("preview");
    expect(stampCardState({ inputs: missing, created: true, replacing: true })).toBe("needs");
    // a stamp made earlier stays shown even when a detail was cleared since
    expect(stampCardState({ inputs: missing, created: true, replacing: false })).toBe("saved");
  });
});

describe("the file", () => {
  // 1 x 1 PNG
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  it("turns a PNG data URL into company-stamp.png, an ordinary PNG that passes the test any picture gets", async () => {
    const file = dataUrlToFile(PNG)!;
    expect(file.name).toBe(STAMP_FILE_NAME);
    expect(file.name).toBe("company-stamp.png");
    expect(file.type).toBe("image/png");
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(file.size).toBe(bytes.length);
    expect(checkImageDataUrl(PNG)).toBe(true);
  });

  it("refuses anything that is not a PNG data URL", () => {
    expect(dataUrlToFile("data:image/jpeg;base64,AAAA")).toBeNull();
    expect(dataUrlToFile("data:image/svg+xml;charset=utf-8,%3Csvg")).toBeNull();
    expect(dataUrlToFile("nonsense")).toBeNull();
    expect(dataUrlToFile("data:image/png;base64,@@@")).toBeNull();
  });
});
