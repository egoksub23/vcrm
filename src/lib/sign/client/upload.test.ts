import { describe, expect, it } from "vitest";

import { MAX_UPLOAD_BYTES, checkUploadFile, formatBytes, isWordFile, titleFromFileName } from "./upload";

describe("checkUploadFile", () => {
  it("accepts a PDF, Word files and images", () => {
    for (const name of ["a.pdf", "A.PDF", "offer letter.docx", "old.doc", "scan.png", "photo.jpg", "photo.JPEG"]) {
      expect(checkUploadFile({ name, size: 1000 }), name).toBeNull();
    }
  });

  it("names the problem with a file the server would refuse", () => {
    expect(checkUploadFile({ name: "notes.txt", size: 10 })).toBe("upload_unsupported");
    expect(checkUploadFile({ name: "noextension", size: 10 })).toBe("upload_unsupported");
    expect(checkUploadFile({ name: "a.pdf", size: 0 })).toBe("upload_empty");
    expect(checkUploadFile({ name: "a.pdf", size: MAX_UPLOAD_BYTES + 1 })).toBe("upload_too_large");
    expect(checkUploadFile({ name: "a.pdf", size: MAX_UPLOAD_BYTES })).toBeNull();
  });

  it("agrees with the server limit of 25 MB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe("file names and sizes", () => {
  it("knows a Word file", () => {
    expect(isWordFile("a.docx")).toBe(true);
    expect(isWordFile("a.DOC")).toBe(true);
    expect(isWordFile("a.pdf")).toBe(false);
  });

  it("makes a title from a file name", () => {
    expect(titleFromFileName("Offer letter.docx")).toBe("Offer letter");
    expect(titleFromFileName("report.final.pdf")).toBe("report.final");
  });

  it("writes sizes", () => {
    expect(formatBytes(500)).toBe("1 KB");
    expect(formatBytes(820 * 1024)).toBe("820 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});
