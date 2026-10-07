import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NextIntlClientProvider } from "next-intl";

import messagesEn from "../../../../messages/en.json";
import messagesMs from "../../../../messages/ms.json";
import messagesZh from "../../../../messages/zh.json";
import messagesKo from "../../../../messages/ko.json";

import { SEALING_SLOW_AFTER_MS, SEALING_STUCK_AFTER_MS, SealingNotice, sealingPhase } from "./end-screens";

// The wait for the signed copy: it says "longer than usual" after two minutes, and after ten it stops spinning (a spinner that never ends reads as a
// frozen page) and says, calmly, that it is taking longer than expected, that nothing is lost, and that the copy will be emailed. (The real
// collection of the owner's test sat on the spinner with nothing more to read.)

const render = (locale: "en" | "ms" | "zh" | "ko", node: React.ReactNode) => {
  const all = { en: messagesEn, ms: messagesMs, zh: messagesZh, ko: messagesKo }[locale];
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={{ Sign: { signer: all.Sign.signer } }} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );
};

describe("sealingPhase", () => {
  it("is waiting for two minutes, slow until ten, then stuck", () => {
    expect(sealingPhase(0)).toBe("waiting");
    expect(sealingPhase(SEALING_SLOW_AFTER_MS - 1)).toBe("waiting");
    expect(sealingPhase(SEALING_SLOW_AFTER_MS)).toBe("slow");
    expect(sealingPhase(SEALING_STUCK_AFTER_MS - 1)).toBe("slow");
    expect(sealingPhase(SEALING_STUCK_AFTER_MS)).toBe("stuck");
    expect(sealingPhase(60 * 60_000)).toBe("stuck");
  });
});

describe("the wait for a document's signed copy", () => {
  it("spins and says what is happening at first", () => {
    const html = render("en", <SealingNotice phase="waiting" />);
    expect(html).toContain("We are finishing your document");
    expect(html).toContain("animate-spin");
    expect(html).not.toContain("longer than");
    expect(html).not.toContain("Check again");
  });

  it("says it is slow after two minutes, and still spins", () => {
    const html = render("en", <SealingNotice phase="slow" />);
    expect(html).toContain("This is taking longer than usual");
    expect(html).toContain("animate-spin");
    expect(html).not.toContain("Check again");
  });

  it("stops the spinner after ten minutes, says it is taking longer than expected and that the copy will be emailed, and offers to check again", () => {
    const html = render("en", <SealingNotice phase="stuck" />);
    expect(html).not.toContain("animate-spin");
    expect(html).toContain("This is taking longer than expected");
    expect(html).toContain("Your signature is saved and nothing is lost");
    expect(html).toContain("we will email it to you");
    expect(html).toContain("Check again");
  });

  it("says the same, for a form that nobody signs, about the record", () => {
    const html = render("en", <SealingNotice phase="stuck" formOnly />);
    expect(html).toContain("We are recording your submission");
    expect(html).toContain("Your submission is saved and nothing is lost");
    expect(html).toContain("The record is still being made");
  });

  it("never uses the word envelope", () => {
    for (const phase of ["waiting", "slow", "stuck"] as const) expect(render("en", <SealingNotice phase={phase} />).toLowerCase()).not.toContain("envelope");
  });

  it("has the stuck words in every language the page speaks", () => {
    for (const locale of ["ms", "zh", "ko"] as const) {
      const html = render(locale, <SealingNotice phase="stuck" />);
      expect(html).not.toContain("Sign.signer");
      expect(html).not.toContain("end.sealing");
      expect(html).not.toContain("animate-spin");
    }
  });
});
