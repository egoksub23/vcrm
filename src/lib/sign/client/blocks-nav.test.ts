import { describe, expect, it } from "vitest";

import type { PlacedField } from "../pdf/types";
import { coverageByPerson, docsNear, jumpTop, landingFor, layoutFor, liveCovers, liveDoc, livePdfs, middleOf, pageSizesOf, pageSlotNear, peopleWithoutBlock, personOfRole, positionAt, slotFor, sortSlots, type Slot } from "./blocks-nav";
import { documentCover } from "./process";
import { person, processDoc, role } from "./process-fixtures";

const ALI = "pp_ali";
const BALA = "pp_bala";
const who = [person(ALI, "Ali"), person(BALA, "Bala")];
const field = (key: string, p: Partial<PlacedField> = {}): PlacedField => ({ key, type: "signature", role: ALI, page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.05, ...p }) as PlacedField;

// three documents: 2 pages, 1 page, a card (a form with nothing printed); each page 1000 px high with 16 px between, a 60 px header before each document
function slots(): Slot[] {
  const out: Slot[] = [];
  let y = 60;
  for (const [doc, pages] of [[0, 2], [1, 1]] as const) {
    for (let p = 0; p < pages; p++) {
      out.push({ doc, page: p, top: y, height: 1000 });
      y += 1016;
    }
    y += 60;
  }
  out.push({ doc: 2, page: 0, top: y, height: 200, card: true });
  return out;
}

describe("which document and page the reader is on", () => {
  const s = slots();
  it("follows the middle of the screen from page 1 of document 1 to the last page of the last document", () => {
    expect(positionAt(s, 0, 800)).toEqual({ doc: 0, page: 0 });
    expect(positionAt(s, 900, 800)).toEqual({ doc: 0, page: 1 });
    expect(positionAt(s, 2100, 800)).toEqual({ doc: 1, page: 0 });
    expect(positionAt(s, 99999, 800)).toEqual({ doc: 2, page: 0 });
  });
  it("takes the nearest page when the middle is between two documents", () => {
    // the header and gap of document 2 sit between 2092 and 2152
    const p = positionAt(s, 2122 - 400, 800);
    expect(p.doc === 0 || p.doc === 1).toBe(true);
  });
  it("is the first page for nothing measured yet", () => {
    expect(positionAt([], 500, 800)).toEqual({ doc: 0, page: 0 });
  });
  it("sorts slots by position", () => {
    const shuffled = [s[3], s[0], s[2], s[1]];
    expect(sortSlots(shuffled).map((x) => x.top)).toEqual([...shuffled.map((x) => x.top)].sort((a, b) => a - b));
  });
});

describe("where a jump goes", () => {
  const s = slots();
  it("brings a document's first page in under its header, never above the top", () => {
    expect(jumpTop(slotFor(s, 1)!, { viewport: 800 })).toBe(2152 - 60);
    expect(jumpTop(slotFor(s, 0)!, { viewport: 800 })).toBe(0);
  });
  it("jumps to a page, and falls back to the document's first page when the page is not measured", () => {
    expect(slotFor(s, 0, 1)?.top).toBe(1076);
    expect(slotFor(s, 0, 9)).toBe(s[0]);
    expect(slotFor(s, 7)).toBeUndefined();
  });
  it("brings a block into view a third of the way down the screen", () => {
    expect(jumpTop(s[1], { viewport: 900, y: 0.5 })).toBe(Math.round(1076 + 500 - 300));
  });
  it("finds the middle of the screen on a page", () => {
    expect(middleOf(s[0], 60 + 600 - 400, 800)).toBeCloseTo(0.6, 3);
  });
});

describe("the page a quick signature block goes on", () => {
  const s = slots();
  it("is the page in the middle of the screen", () => {
    expect(pageSlotNear(s, 1100, 800)?.doc).toBe(0);
    expect(pageSlotNear(s, 1100, 800)?.page).toBe(1);
  });
  it("skips a card and takes the nearest page", () => {
    const near = pageSlotNear(s, 99999, 800);
    expect(near?.doc).toBe(1);
    expect(near?.card).toBeUndefined();
  });
  it("is nothing when no document has a page", () => {
    expect(pageSlotNear([{ doc: 0, page: 0, top: 0, height: 100, card: true }], 0, 800)).toBeNull();
  });
});

describe("which files are open", () => {
  // six documents of 3000 px each
  const ranges = Array.from({ length: 6 }, (_, i) => ({ top: i * 3000, bottom: i * 3000 + 2900 }));
  it("finds the documents near the screen", () => {
    expect(docsNear(ranges, 3100, 800, 0)).toEqual([1]);
    expect(docsNear(ranges, 3100, 800, 1500)).toEqual([0, 1]);
    expect(docsNear(ranges, 3100, 800, 2500)).toEqual([0, 1, 2]);
  });
  it("opens the ones on the screen and the nearest just off it, at most `max` when fewer are on the screen", () => {
    expect(livePdfs({ ranges, scrollTop: 3100, viewport: 800, margin: 2500, current: 1, max: 2 })).toEqual([0, 1]);
    expect(livePdfs({ ranges, scrollTop: 3100, viewport: 800, margin: 2500, current: 1, max: 3 })).toEqual([0, 1, 2]);
  });
  it("never leaves a document on the screen without its file, however many there are", () => {
    const tiny = Array.from({ length: 6 }, (_, i) => ({ top: i * 100, bottom: i * 100 + 90 }));
    expect(livePdfs({ ranges: tiny, scrollTop: 0, viewport: 700, margin: 500, current: 0, max: 3 })).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it("keeps a pinned document (one being jumped to) open", () => {
    expect(livePdfs({ ranges, scrollTop: 0, viewport: 800, margin: 500, current: 0, max: 2, pinned: [4] })).toEqual([0, 4]);
  });
  it("estimates a page's size before its file is open, and uses the real one after", () => {
    expect(pageSizesOf(undefined, 3)).toHaveLength(3);
    expect(pageSizesOf(undefined, null)).toHaveLength(1);
    expect(pageSizesOf([{ width: 612, height: 792 }], 3)).toEqual([{ width: 612, height: 792 }]);
  });
});

describe("what each person has, from the blocks on the screen", () => {
  const d1 = processDoc(1, { roles: [role(ALI, "Ali", 0), role(BALA, "Bala", 1)], signatureCounts: { [ALI]: 0, [BALA]: 0 } });
  const d2 = processDoc(2, { roles: [role(ALI, "Ali", 0), role(BALA, "Bala", 1)], signatureCounts: { [ALI]: 1, [BALA]: 0 } });

  it("counts a signature or initials block as the server does, and ignores other fields", () => {
    const live = liveDoc(d1, [field("a"), field("b", { type: "initials", role: BALA }), field("c", { type: "text" }), field("d", { role: "sender" })]);
    expect(live.signatureCounts).toEqual({ [ALI]: 1, [BALA]: 1 });
    expect(live.fieldCounts).toEqual({ [ALI]: 2, [BALA]: 1 });
    expect(liveDoc(d1, null)).toBe(d1);
  });

  it("covers follow the blocks placed now, before the server has been told", () => {
    const fields: Record<string, PlacedField[]> = { [d1.id]: [field("a")] };
    const covers = liveCovers([d1, d2], who, (id) => fields[id]);
    expect(covers[0].blocks).toBe(1);
    // document 2 is not read yet: the server's counts stand
    expect(covers[1].blocks).toBe(1);
    expect(covers[0].people.find((p) => p.key === ALI)?.covered).toBe(true);
    expect(covers[0].people.find((p) => p.key === BALA)?.covered).toBe(false);
  });

  it("says on how many of their documents each person has a block", () => {
    const covers = [documentCover(d1, who), documentCover(d2, who)];
    const cov = coverageByPerson(covers, who);
    expect(cov.find((c) => c.key === ALI)).toMatchObject({ of: 2, on: 1, blocks: 1, complete: false });
    expect(cov.find((c) => c.key === BALA)).toMatchObject({ of: 2, on: 0, blocks: 0, complete: false });
    const full = coverageByPerson([documentCover(liveDoc(d1, [field("a"), field("b", { role: BALA })]), who), documentCover(liveDoc(d2, [field("c"), field("d", { role: BALA })]), who)], who);
    expect(full.every((c) => c.complete && c.on === 2 && c.of === 2)).toBe(true);
  });

  it("marks a document where a person who must sign has no block", () => {
    expect(peopleWithoutBlock(documentCover(d2, who))).toEqual([BALA]);
    expect(peopleWithoutBlock(documentCover(liveDoc(d2, [field("a"), field("b", { role: BALA })]), who))).toEqual([]);
  });

  it("finds the person a block belongs to, for an uploaded file and for a template's matched role", () => {
    expect(personOfRole(who, d1, BALA)).toBe(BALA);
    expect(personOfRole(who, d1, "sender")).toBeNull();
    const tpl = processDoc(3, { fromTemplate: true, roles: [role("buyer", "Buyer")] });
    const matched = [person(ALI, "Ali", { roles: { [tpl.id]: "buyer" } }), person(BALA, "Bala")];
    expect(personOfRole(matched, tpl, "buyer")).toBe(ALI);
    expect(personOfRole(matched, tpl, "seller")).toBeNull();
  });
});

describe("where the step lands", () => {
  const ids = ["d1", "d2", "d3"];
  const fieldsOf = (id: string) => (id === "d2" ? [field("blk", { page: 2, y: 0.4 })] : id === "d3" ? undefined : []);

  it("opens on the top for no document, or one that is not in the collection", () => {
    expect(landingFor({}, ids, fieldsOf)).toBeNull();
    expect(landingFor({ doc: "nope" }, ids, fieldsOf)).toBeNull();
  });
  it("opens on the document named in ?doc=", () => {
    expect(landingFor({ doc: "d2" }, ids, fieldsOf)).toEqual({ landing: { doc: 1, page: 0, y: 0, key: null }, settled: true });
  });
  it("lands on a Fix button's block: its document, its page and the block selected", () => {
    expect(landingFor({ doc: "d2", block: "blk" }, ids, fieldsOf)).toEqual({ landing: { doc: 1, page: 2, y: 0.4, key: "blk" }, settled: true });
  });
  it("falls back to the document when the block is gone, and waits while the document is still being read", () => {
    expect(landingFor({ doc: "d2", block: "gone" }, ids, fieldsOf)?.landing).toEqual({ doc: 1, page: 0, y: 0, key: null });
    expect(landingFor({ doc: "d3", block: "blk" }, ids, fieldsOf)).toEqual({ landing: { doc: 2, page: 0, y: 0, key: null }, settled: false });
  });
});

describe("how much the screen can do", () => {
  it("is three columns from 1040 px, slide-over columns from 640 px, and only looking below that", () => {
    expect([1440, 1280, 1040].map(layoutFor)).toEqual(["desktop", "desktop", "desktop"]);
    expect([1039, 768, 640].map(layoutFor)).toEqual(["tablet", "tablet", "tablet"]);
    expect([639, 375, 360].map(layoutFor)).toEqual(["phone", "phone", "phone"]);
    // not measured yet: the full editor, so the first paint is not a phone's
    expect(layoutFor(0)).toBe("desktop");
  });
});
