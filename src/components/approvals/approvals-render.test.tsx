import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";

import en from "../../../messages/en.json";
import ko from "../../../messages/ko.json";

import { ApprovalChip } from "./approval-chip";
import { ProposalDiff } from "./proposal-diff";

// Server-render smoke tests with the real en / ko messages: they pin that the
// chips and the Current vs Proposed view resolve to real text (a missing key
// would throw here) and that the right viewer sees the right chip.

const messagesFor = { en, ko } as const;

function render(node: React.ReactNode, locale: "en" | "ko" = "en") {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={messagesFor[locale] as never}
      timeZone="UTC"
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const ME = "u-me";

describe("ApprovalChip", () => {
  it("shows Pending to the proposer, in both languages", () => {
    const row = { approval_status: "pending" as const, proposed_by: ME };
    expect(render(<ApprovalChip row={row} viewerId={ME} canReview={false} />)).toContain("Pending");
    expect(render(<ApprovalChip row={row} viewerId={ME} canReview={false} />, "ko")).toContain("대기 중");
  });

  it("shows nothing to someone who did not propose it and cannot review", () => {
    const row = { approval_status: "pending" as const, proposed_by: ME };
    expect(render(<ApprovalChip row={row} viewerId="u-other" canReview={false} />)).toBe("");
  });

  it("shows the reviewer's note as the tooltip of a Rejected chip", () => {
    const html = render(
      <ApprovalChip
        row={{ approval_status: "rejected", proposed_by: ME, decision_note: "Too vague" }}
        viewerId={ME}
        canReview={false}
      />,
    );
    expect(html).toContain("Rejected");
    expect(html).toContain("Rejected: Too vague");
  });

  it("shows Pending changes on a live row with a pending edit", () => {
    const html = render(
      <ApprovalChip
        row={{ approval_status: "approved", proposed_by: ME, pending_edit: { name: "x" }, edit_status: "pending" }}
        viewerId={ME}
        canReview={false}
      />,
    );
    expect(html).toContain("Pending changes");
  });

  it("shows nothing on an ordinary live row", () => {
    expect(render(<ApprovalChip row={{ approval_status: "approved" }} viewerId={ME} canReview />)).toBe("");
  });
});

describe("ProposalDiff", () => {
  it("shows Current vs Proposed for an edit and highlights the changed row", () => {
    const html = render(
      <ProposalDiff
        entity="tag"
        current={{ name: "VIP", color: "#111111", description: null, for_contacts: true, for_conversations: true }}
        proposed={{ name: "VIP gold", color: "#111111", description: null, for_contacts: true, for_conversations: true }}
      />,
    );
    expect(html).toContain("Current");
    expect(html).toContain("Proposed");
    expect(html).toContain("VIP gold");
    expect(html).toContain("line-through");
  });

  it("previews a new snippet as a single column", () => {
    const html = render(
      <ProposalDiff
        entity="snippet"
        current={null}
        proposed={{ title: "Business hours", kind: "text", content_text: "We open at 9", interactive_payload: null }}
      />,
    );
    expect(html).toContain("Preview");
    expect(html).not.toContain("Current");
    expect(html).toContain("Business hours");
    expect(html).toContain("We open at 9");
  });

  it("draws a colour as a swatch and translates in Korean", () => {
    const html = render(
      <ProposalDiff entity="tag" current={null} proposed={{ name: "Wholesale", color: "#ff8800" }} />,
      "ko",
    );
    expect(html).toContain("background-color:#ff8800");
    expect(html).toContain("미리보기");
  });
});
