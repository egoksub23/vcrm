import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";

import en from "../../messages/en.json";

// UI gating sweep: write controls stay on screen but are disabled (with the
// "Read-only, your role can't ..." tooltip) for someone who lacks the capability
// that guards them, and are enabled for someone who holds it. Server-rendered
// with the real English messages; `useCapability` is driven by a per-test set,
// so a Viewer (no capabilities), a trimmed Agent (a few, none of the ones under
// test) and a holder are the same component rendered three ways.

const state = vi.hoisted(() => ({ caps: new Set<string>() }));

vi.mock("@/hooks/use-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-auth")>();
  return {
    ...actual,
    useAuth: () => ({
      accountId: "acc-1",
      user: { id: "u-me" },
      accountRole: "agent",
      defaultCurrency: "USD",
      currencies: [],
      capabilities: state.caps,
      capabilitiesLoading: false,
      profileLoading: false,
      loading: false,
    }),
    useCapability: (cap: string) => state.caps.has(cap),
  };
});

vi.mock("@/lib/supabase/client", () => {
  // Only ever called while rendering (effects do not run in a server render).
  const stub: unknown = new Proxy(function () {}, {
    get: () => stub,
    apply: () => stub,
  });
  return { createClient: () => stub };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  usePathname: () => "/",
}));

vi.mock("@/hooks/use-tags", () => ({
  useTags: () => ({
    tags: [],
    contactTags: [],
    conversationLabels: [{ id: "l1", name: "Billing", color: "#ff0000" }],
    loading: false,
  }),
}));

import { AutoLabelSettings } from "./settings/auto-label-settings";
import { QuickRepliesManager } from "./settings/quick-replies-manager";
import { TagCatalogPanel } from "./settings/tags/tag-catalog-panel";
import { CustomFieldsPanel } from "./contacts/custom-fields-manager";
import { TeamSection } from "./settings/team/team-section";
import { PipelineBoard } from "./pipelines/pipeline-board";
import { Step4ScheduleSend } from "./broadcasts/step4-schedule-send";
import { AutomationBuilder } from "./automations/automation-builder";
import { FlowEditorProvider } from "./flows/flow-editor-state";
import { EditorHeader } from "./flows/header";
import ContactsPage from "../app/(dashboard)/contacts/page";
import TicketsPage from "../app/(dashboard)/tickets/page";
import { KnowledgeLibrary } from "./knowledge/knowledge-library";
import { BulkActionsBar } from "./inbox/bulk-actions-bar";
import { MessageActions } from "./inbox/message-actions";
import { ConversationSummaryCard } from "./inbox/conversation-summary-card";
import { AiPlayground } from "./agents/ai-playground";
import type { Deal, Message, PipelineStage } from "@/types";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={en as never}
      timeZone="UTC"
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

function as(caps: string[], node: React.ReactNode) {
  state.caps = new Set(caps);
  return render(node);
}

interface Found {
  text: string;
  disabled: boolean;
  tag: string;
}

/** Every <button> / switch / <input> / <textarea> in the markup, with its visible text or aria-label. */
function controls(html: string): Found[] {
  const out: Found[] = [];
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const attrs = m[1];
    const aria = /aria-label="([^"]*)"/.exec(attrs)?.[1] ?? "";
    const title = /title="([^"]*)"/.exec(attrs)?.[1] ?? "";
    const text = m[2].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    out.push({ tag: "button", text: `${text} ${aria} ${title}`.trim(), disabled: /\sdisabled(=|\s|>|$)/.test(` ${attrs}`) });
  }
  for (const m of html.matchAll(/<span\b([^>]*role="switch"[^>]*)>/g)) {
    const attrs = m[1];
    const aria = /aria-label="([^"]*)"/.exec(attrs)?.[1] ?? "";
    out.push({ tag: "switch", text: aria, disabled: /aria-disabled="true"/.test(attrs) });
  }
  for (const m of html.matchAll(/<(input|textarea)\b([^>]*)>/g)) {
    const attrs = m[2];
    const aria = /aria-label="([^"]*)"/.exec(attrs)?.[1] ?? "";
    const ph = /placeholder="([^"]*)"/.exec(attrs)?.[1] ?? "";
    out.push({ tag: m[1], text: `${aria} ${ph}`.trim(), disabled: /\sdisabled(=|\s|>|$)/.test(` ${attrs}`) });
  }
  return out;
}

function ctl(html: string, label: string | RegExp, tag = "button"): Found {
  const hit = controls(html).find(
    (c) => c.tag === tag && (typeof label === "string" ? c.text.includes(label) : label.test(c.text)),
  );
  if (!hit) {
    throw new Error(`no <${tag}> matching ${String(label)} in: ${controls(html).map((c) => c.text).join(" | ")}`);
  }
  return hit;
}

const readOnly = (what: string) => `Read-only — your role can&#x27;t ${what}`;

// A trimmed Agent: replies, works conversations, drafts knowledge and proposes
// tags and snippets, but holds none of the capabilities exercised below.
const TRIMMED_AGENT = [
  "messages.send",
  "conversations.manage",
  "knowledge.draft",
  "snippets.propose",
  "tags.propose",
  "menu.inbox",
  "menu.contacts",
];

describe("settings managers", () => {
  it("auto-label rules: disabled without tags.manage, enabled with it", () => {
    const label = en.Settings.autoLabels.addRule;
    const viewer = as([], <AutoLabelSettings />);
    expect(ctl(viewer, label).disabled).toBe(true);
    expect(viewer).toContain(readOnly("manage auto-label rules"));
    expect(ctl(viewer, en.Settings.autoLabels.aiToggle, "switch").disabled).toBe(true);

    const agent = as(TRIMMED_AGENT, <AutoLabelSettings />);
    expect(ctl(agent, label).disabled).toBe(true);

    const holder = as(["tags.manage"], <AutoLabelSettings />);
    expect(ctl(holder, label).disabled).toBe(false);
    expect(holder).not.toContain("manage auto-label rules");
  });

  it("quick replies: New quick reply is shown to a Viewer but disabled; snippets.propose or snippets.manage enable it", () => {
    const viewer = as([], <QuickRepliesManager />);
    expect(ctl(viewer, "New quick reply").disabled).toBe(true);
    expect(viewer).toContain(readOnly("manage quick replies"));

    // The propose flow is untouched: a proposer still gets an enabled button.
    expect(ctl(as(["snippets.propose"], <QuickRepliesManager />), "New quick reply").disabled).toBe(false);
    expect(ctl(as(["snippets.manage"], <QuickRepliesManager />), "New quick reply").disabled).toBe(false);
  });

  it("tags: Create and Import stay visible; a proposer can create but not import; tags.manage does both", () => {
    const create = en.Settings.tagCatalog.tag.createButton;
    const imp = en.Settings.tagCatalog.importCsv;

    const viewer = as([], <TagCatalogPanel kind="tag" />);
    expect(ctl(viewer, create).disabled).toBe(true);
    expect(ctl(viewer, imp).disabled).toBe(true);
    expect(viewer).toContain(readOnly("create tags"));

    const agent = as(["tags.propose"], <TagCatalogPanel kind="tag" />);
    expect(ctl(agent, create).disabled).toBe(false);
    expect(ctl(agent, imp).disabled).toBe(true);

    const admin = as(["tags.manage"], <TagCatalogPanel kind="tag" />);
    expect(ctl(admin, create).disabled).toBe(false);
    expect(ctl(admin, imp).disabled).toBe(false);
  });

  it("custom fields: the name box and Add field need settings.workspace", () => {
    const add = en.Contacts.customFields.addField;
    const name = en.Contacts.customFields.fieldName;
    const viewer = as([], <CustomFieldsPanel />);
    expect(ctl(viewer, add).disabled).toBe(true);
    expect(ctl(viewer, name, "input").disabled).toBe(true);
    expect(viewer).toContain(readOnly("edit custom fields"));

    const agent = as(TRIMMED_AGENT, <CustomFieldsPanel />);
    expect(ctl(agent, name, "input").disabled).toBe(true);

    const admin = as(["settings.workspace"], <CustomFieldsPanel />);
    expect(ctl(admin, name, "input").disabled).toBe(false);
  });

  it("team: Invite member is disabled without members.invite", () => {
    const invite = en.Settings.team.inviteMember;
    expect(ctl(as([], <TeamSection />), invite).disabled).toBe(true);
    expect(ctl(as(TRIMMED_AGENT, <TeamSection />), invite).disabled).toBe(true);
    expect(ctl(as(["members.invite"], <TeamSection />), invite).disabled).toBe(false);
  });
});

describe("contacts", () => {
  it("Add contact, Import and Custom fields need contacts.edit / settings.workspace", () => {
    const t = en.Contacts.page;
    const viewer = as([], <ContactsPage />);
    expect(ctl(viewer, t.addContactBtn).disabled).toBe(true);
    expect(ctl(viewer, t.importBtn).disabled).toBe(true);
    expect(ctl(viewer, t.customFieldsBtn).disabled).toBe(true);
    expect(viewer).toContain(readOnly("add or import contacts"));
    expect(viewer).toContain(readOnly("edit custom fields"));

    // A trimmed Agent without contacts.edit is still read-only here.
    const agent = as(TRIMMED_AGENT.filter((c) => c !== "contacts.edit"), <ContactsPage />);
    expect(ctl(agent, t.addContactBtn).disabled).toBe(true);

    const holder = as(["contacts.edit"], <ContactsPage />);
    expect(ctl(holder, t.addContactBtn).disabled).toBe(false);
    expect(ctl(holder, t.importBtn).disabled).toBe(false);
    // Custom fields is workspace configuration, a separate capability.
    expect(ctl(holder, t.customFieldsBtn).disabled).toBe(true);
    expect(ctl(as(["contacts.edit", "settings.workspace"], <ContactsPage />), t.customFieldsBtn).disabled).toBe(false);
  });
});

describe("tickets", () => {
  it("New Ticket needs tickets.work", () => {
    const label = en.Tickets.list.newTicket;
    const viewer = as([], <TicketsPage />);
    expect(ctl(viewer, label).disabled).toBe(true);
    expect(ctl(as(TRIMMED_AGENT, <TicketsPage />), label).disabled).toBe(true);
    expect(ctl(as(["tickets.work"], <TicketsPage />), label).disabled).toBe(false);
  });
});

describe("pipelines and deals", () => {
  const stages = [
    { id: "s1", pipeline_id: "p1", name: "Lead", color: "#3b82f6", position: 0 },
  ] as unknown as PipelineStage[];
  const board = (
    <PipelineBoard stages={stages} deals={[] as Deal[]} onDealMoved={() => {}} onAddDeal={() => {}} onEditDeal={() => {}} />
  );

  it("the per-stage Add deal button needs deals.manage", () => {
    const add = en.Pipelines.board.addDeal;
    const viewer = as([], board);
    expect(ctl(viewer, add).disabled).toBe(true);
    expect(viewer).toContain(readOnly("create deals"));
    // pipelines.configure alone does not let someone create deals.
    expect(ctl(as(["pipelines.configure"], board), add).disabled).toBe(true);
    expect(ctl(as(["deals.manage"], board), add).disabled).toBe(false);
  });
});

describe("broadcasts", () => {
  const step = (
    <Step4ScheduleSend
      template={{ id: "t1", name: "Promo", language: "en" } as never}
      audience={{ type: "all" as const }}
      name="Autumn promo"
      onNameChange={() => {}}
      onBack={() => {}}
      onSend={() => {}}
      onSaveDraft={() => {}}
      isProcessing={false}
      progress={0}
    />
  );

  it("Save draft and Send now need broadcasts.send", () => {
    const save = en.Broadcasts.wizard.scheduleSend.saveDraft;
    const send = en.Broadcasts.wizard.scheduleSend.sendNow;
    const viewer = as([], step);
    expect(ctl(viewer, save).disabled).toBe(true);
    expect(ctl(viewer, send).disabled).toBe(true);
    expect(viewer).toContain(readOnly("send broadcasts"));

    const agent = as(TRIMMED_AGENT, step);
    expect(ctl(agent, send).disabled).toBe(true);

    const holder = as(["broadcasts.send"], step);
    expect(ctl(holder, save).disabled).toBe(false);
    expect(ctl(holder, send).disabled).toBe(false);
  });
});

describe("automations", () => {
  const builder = (
    <AutomationBuilder
      initial={{
        id: "a1",
        name: "Welcome",
        description: "",
        trigger_type: "new_message_received",
        trigger_config: {},
        is_active: false,
        steps: [],
      } as never}
    />
  );

  it("Save and the Active switch need automations.manage", () => {
    const save = en.Automations.builder.save;
    const active = en.Automations.builder.activeAria;
    const viewer = as([], builder);
    expect(ctl(viewer, save).disabled).toBe(true);
    expect(viewer).toContain(readOnly("manage automations"));
    expect(ctl(viewer, active, "switch").disabled).toBe(true);
    expect(ctl(as(TRIMMED_AGENT, builder), save).disabled).toBe(true);
    expect(ctl(as(["automations.manage"], builder), save).disabled).toBe(false);
  });
});

describe("flows", () => {
  const flow = {
    id: "f1",
    account_id: "acc-1",
    user_id: "u-me",
    name: "Welcome flow",
    description: null,
    status: "draft",
    trigger_type: "manual",
    trigger_config: {},
    entry_node_id: null,
    fallback_policy: "end",
    execution_count: 0,
    last_executed_at: null,
    created_at: "",
    updated_at: "",
  } as never;
  const header = (
    <FlowEditorProvider initialFlow={flow} initialNodes={[]}>
      <EditorHeader />
    </FlowEditorProvider>
  );

  it("the editor header: Save, Activate and Delete need flows.manage", () => {
    const t = en.Flows.header;
    const viewer = as([], header);
    for (const label of [t.save, t.activate, t.delete]) {
      expect(ctl(viewer, label).disabled).toBe(true);
    }
    expect(ctl(viewer, t.namePlaceholder, "input").disabled).toBe(true);
    expect(viewer).toContain(readOnly("manage flows"));

    const agent = as(TRIMMED_AGENT, header);
    expect(ctl(agent, t.save).disabled).toBe(true);
    expect(ctl(agent, t.delete).disabled).toBe(true);

    const holder = as(["flows.manage"], header);
    expect(ctl(holder, t.save).disabled).toBe(false);
    expect(ctl(holder, t.delete).disabled).toBe(false);
    expect(ctl(holder, t.namePlaceholder, "input").disabled).toBe(false);
  });
});

describe("knowledge library", () => {
  it("Reindex, Add content and Manage collections are shown but disabled without knowledge.manage / knowledge.draft", () => {
    const reindex = en.Knowledge.reindex;
    const add = en.Knowledge.addContent.button;

    const viewer = as([], <KnowledgeLibrary />);
    expect(ctl(viewer, reindex).disabled).toBe(true);
    expect(ctl(viewer, add).disabled).toBe(true);
    expect(viewer).toContain(readOnly("reindex the knowledge base"));

    // Drafting is enough to add content, not to reindex or manage collections.
    const agent = as(["knowledge.draft"], <KnowledgeLibrary />);
    expect(ctl(agent, add).disabled).toBe(false);
    expect(ctl(agent, reindex).disabled).toBe(true);
  });
});

describe("inbox", () => {
  const conv = { id: "c1", status: "open", unread_count: 0, assigned_agent_id: null } as never;

  it("bulk bar: assign, mark read/unread and close need conversations.manage", () => {
    const bar = (
      <BulkActionsBar
        selected={[conv]}
        visibleCount={3}
        onSelectAll={() => {}}
        onClear={() => {}}
        onPatch={() => {}}
        onDone={() => {}}
        labelControl={null}
      />
    );
    const t = en.Inbox.conversationList.bulk;
    const viewer = as([], bar);
    expect(ctl(viewer, t.assign).disabled).toBe(true);
    expect(ctl(viewer, t.close).disabled).toBe(true);
    // The two icon-only buttons carry the read-only hint as their title.
    const locked = controls(viewer).filter((c) => c.text.includes("manage conversations"));
    expect(locked).toHaveLength(4);
    expect(locked.every((c) => c.disabled)).toBe(true);
    // Replying alone does not let someone bulk-close.
    expect(ctl(as(["messages.send"], bar), t.close).disabled).toBe(true);
    const holder = as(["conversations.manage"], bar);
    for (const label of [t.assign, t.markRead, t.markUnread, t.close]) {
      expect(ctl(holder, label).disabled).toBe(false);
    }
  });

  it("message toolbar: react, reply and move to trash need messages.send; copy stays available", () => {
    const msg = { id: "m1", sender_type: "customer", content_text: "hello", is_internal: false } as unknown as Message;
    const toolbar = (
      <MessageActions message={msg} onReply={() => {}} onReact={() => {}} onTrash={() => {}}>
        <span>hello</span>
      </MessageActions>
    );
    const t = en.Inbox.actions;
    const viewer = as([], toolbar);
    expect(ctl(viewer, t.react).disabled).toBe(true);
    expect(ctl(viewer, t.reply).disabled).toBe(true);
    expect(ctl(viewer, t.moveToTrash).disabled).toBe(true);
    expect(ctl(viewer, t.copyText).disabled).toBe(false);

    const holder = as(["messages.send"], toolbar);
    expect(ctl(holder, t.react).disabled).toBe(false);
    expect(ctl(holder, t.reply).disabled).toBe(false);
    expect(ctl(holder, t.moveToTrash).disabled).toBe(false);
  });

  it("AI summary needs ai.use", () => {
    const card = <ConversationSummaryCard conversationId="c1" />;
    const label = en.Inbox.summary.button;
    expect(ctl(as([], card), label).disabled).toBe(true);
    expect(as([], card)).toContain(readOnly("use AI"));
    expect(ctl(as(["messages.send"], card), label).disabled).toBe(true);
    expect(ctl(as(["ai.use"], card), label).disabled).toBe(false);
  });
});

describe("AI assistant playground", () => {
  it("the message box and Send need ai.use", () => {
    const placeholder = en.Agents.playground.placeholder;
    const viewer = as([], <AiPlayground />);
    expect(ctl(viewer, placeholder, "textarea").disabled).toBe(true);
    expect(as(["ai.use"], <AiPlayground />)).not.toContain("Read-only");
    expect(ctl(as(["ai.use"], <AiPlayground />), placeholder, "textarea").disabled).toBe(false);
  });
});
