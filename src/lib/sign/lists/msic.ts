// ============================================================
// MSIC 2008: the Malaysia Standard Industrial Classification, as the system list `msic`.
//
// SOURCE   Department of Statistics Malaysia (DOSM), dataset "MSIC" (Malaysian Standard Industrial Classification
//          2008) in the national open data catalogue.
//          Page      https://open.dosm.gov.my/data-catalogue/msic
//          API       https://api.data.gov.my/data-catalogue?id=msic     (the file msic.csv / msic.parquet behind it)
//          Licence   Creative Commons Attribution 4.0 International (CC BY 4.0), (c) Department of Statistics Malaysia
//          Dataset   "last updated 31 December 2008, next update N/A" (a 2008 classification: MSIC has not been revised since)
// RETRIEVED 2026-10-07, division by division through the catalogue's API (one request per two-digit division).
// WHAT IT IS 21 sections (A to U), 88 divisions and 1,174 five-digit classes, each with an English and a Bahasa Melayu
//          description exactly as DOSM publishes them. LHDN's e-invoice MSIC code list is this same classification.
// VERIFIED  * The set of five-digit codes of every one of the 88 divisions was fetched twice, by two separate requests
//             (with the descriptions, and with the codes alone), and the two sets agree exactly: 1,174 codes.
//           * Descriptions were compared, by a script, against a second verbatim copy of the API's JSON for three
//             divisions (20, 62 and 64: 47 classes) and are equal once the cleaning below is applied.
//           * Well-known codes spot-checked: 01111 Growing of maize, 47111 Provision stores, 62010 Computer programming
//             activities, 62021 Computer consultancy, 96091 Activities of sauna, steam baths, massage salons.
//           What is NOT checked: every description of every division was read once from the source; none was
//           compared a second time (only the samples above). The data below is DOSM's, not ours: when a wording is
//           odd (for example 20131 is labelled "plastic in primary forms" in English and "getah sintetik" in Malay) it is odd
//           in the source too and was not "corrected". An admin can edit any label in Settings > Doc Sign > Lists.
// CLEANING  Only these, applied to every description:
//           * footnote markers that the source glues to the end of the Malay text ("(2)", "(4", a stray "(") were removed,
//             and one in the middle of 35201;
//           * the spreadsheet artefact "_x000D_" (a line break) in 64924 became a space;
//           * runs of white space were collapsed.
//           Nothing else was touched: no code was added, removed or renumbered, and no wording was changed.
// SHAPE     msic.json: { sections: [{code, en, ms}], divisions: [{code, section, en, ms}], items: [{code, division, section, en, ms}] }
//
// Chinese and Korean labels do not exist in the source and are not invented: a signer in those languages reads the
// English text (the form falls back to English).
// ============================================================

import data from "./msic.json";
import type { ListItem } from "./types";

export interface MsicSection {
  code: string;
  en: string;
  ms: string;
}
export interface MsicDivision extends MsicSection {
  section: string;
}
export interface MsicClass extends MsicSection {
  division: string;
  section: string;
}

interface MsicFile {
  sections: MsicSection[];
  divisions: MsicDivision[];
  items: MsicClass[];
}

const file = data as MsicFile;

export const MSIC_SOURCE = {
  name: "Department of Statistics Malaysia (DOSM), MSIC 2008",
  url: "https://open.dosm.gov.my/data-catalogue/msic",
  api: "https://api.data.gov.my/data-catalogue?id=msic",
  licence: "CC BY 4.0",
  retrieved: "2026-10-07",
} as const;

export const MSIC_SECTIONS: readonly MsicSection[] = file.sections;
export const MSIC_DIVISIONS: readonly MsicDivision[] = file.divisions;
export const MSIC_CLASSES: readonly MsicClass[] = file.items;

/** The list's items: one per five-digit class, grouped under its two-digit division, in code order. */
export function msicItems(): ListItem[] {
  return file.items.map((c) => ({ value: c.code, label: { en: c.en, ms: c.ms }, group: c.division }));
}
