# AI in automations

Automations can call the AI as a building block. This page explains what each AI
step does, the guardrails that apply to all of them, what they cost, how to test
a step before it touches a customer, and a few examples.

It builds on the AI platform you already have (AI Agents > Setup, Connections,
the monthly token budget, the knowledge base). It is not an autonomous agent: an
AI step does one narrow thing, its output is treated as data, and it can only do
what the step is configured to do.

## Before you start

1. **Set up AI** in AI Agents > Setup (your own key; OpenAI, Anthropic or an
   OpenAI-compatible service such as Kimi).
2. If your provider is an **OpenAI-compatible host**, confirm the customer-data
   notice in Setup ("customer messages will be sent to this host"). AI steps
   refuse to run until it is confirmed. OpenAI and Anthropic (your own key) have
   never needed that flag, so nothing extra is asked for them.
3. In AI Agents > Connections, the table has a row **Automations** ("Steps inside
   automations"). It works like every other row: pick a connection, optionally a
   cheaper model, or switch the job off. It is on by default and uses the default
   connection.
4. Needed permissions: `automations.manage` to build; `ai.use` as well to use the
   **Test this step** button.

An AI step can always be **added and saved** in a draft. **Activating** an
automation that has AI steps is refused, with a clear message, while AI is not
set up, is switched off, the Automations job is off, or the notice is missing
(the check is on the server, in `validate.ts`, so the API says no too, not just
the screen). The builder shows the same warning on each AI step card with a link
to AI Agents > Setup.

## The steps

All AI steps are in the **AI** group of the Add step menu (sparkle icon). Every
one has a title, its instructions field with an **Insert variable** dropdown, an
**If the AI call fails** choice and a note that it uses AI tokens. The first AI
step in an automation also shows a callout: customer text is sent to your AI
provider.

### AI reply (`ai_reply`)

Writes an answer to the customer's latest message from your **knowledge base**
and the workspace's **business context** (AI Agents > Setup > system prompt).
It uses the same pieces as the auto-reply bot: the same retrieval, the same
system prompt scaffold (including the "customer text is untrusted" and hand-off
rules), the same `[n]` citations, and the same "send the files of the articles
used, and leave the *AI answered from* note" step. Auto-reply itself was not
changed.

Options:

- **What to do with the answer**: send it to the customer, or save it as an
  **internal draft note** for the agent (nothing reaches the customer).
- **Extra instructions**: tone, what not to promise. Variables are allowed.
- **Language**: match the customer (the default; a contact's preferred language
  is honoured) or a fixed language.
- **Even if an agent is assigned**: off by default. The AI never *sends* while a
  person owns the conversation. A draft note is for the agent, so an assignment
  does not stop it.
- The **AI take over** pause on a conversation is always honoured (send and
  draft).

Two outcomes, drawn as two columns like a Condition:

- **Answered** continues in the left column.
- **Couldn't answer** continues in the right column. That is: no matching
  knowledge and no business context, the AI asked for a person (the hand-off
  signal), a person owns the conversation, the conversation is paused, or the
  customer's message was already answered (this last one also keeps a replayed
  trigger from answering twice), or an AI failure (see On failure).

The answer is also saved in `vars.ai_reply`.

### Ask AI, yes or no (a subject of the Condition step)

Pick **Ask AI (yes/no)** as the Condition's subject, or choose it from the AI
group. The operand is a plain-language question about the conversation, for
example "Is the customer asking for a refund?" or "Is the customer angry?". The
AI reads the last N messages (default 10, 1 to 30). The model must answer
`yes`, `no` or `unsure`; the answer is parsed defensively (JSON or plain text),
and **anything that is not clearly yes or no is treated as unsure**.

**Unsure, and any failure, follow the No branch.** (You can choose Stop this
automation for failures instead.) The Test panel shows the model's short reason.

### AI classify and extract (`ai_extract`)

Define up to **8 fields**. Each has a key (lower-case letters, digits,
underscores), a description of what to look for, and a type: text, number, date
(yyyy-mm-dd), yes/no, or a **choice** with up to 12 choices. The AI returns JSON,
which is **validated strictly**:

- the right type; a choice must be one of the choices (case is normalised);
  dates must be real calendar dates; text is capped at 500 characters;
- a field the AI leaves empty is just "not found";
- a field that fails validation is **left empty, logged, and never written**.

Every field is saved into `vars.<key>` (always; empty when nothing valid was
found). A field can **also** be saved to:

- a standard contact field (name, email, company), checked against that field's
  own rules (a real email address, sensible lengths);
- a custom contact field;
- for a choice: **apply the conversation label** or **add the contact tag** with
  the same name as the choice. Only a label or tag that already exists (and is
  approved) is used. **Nothing is ever created.**

A contact field that already has a value is **kept** unless **Overwrite existing
values** is ticked.

Presets: **Sentiment** (positive / neutral / negative) and **Topic** (a list of
choices you edit).

### AI summarise (`ai_summarize`)

Summarises the conversation with the same prompt and cleaner as the inbox
**Summarise** button, into `vars.summary` (the variable name can be changed) and,
if ticked, as an **internal note** on the conversation.

### AI translate (`ai_translate`)

Translates a text into a target language, into `vars.translation` (name
changeable). The source is the customer's last message unless you give a text or
a variable such as `{{ vars.summary }}`. This uses a small dedicated prompt (the
knowledge-base article translator is HTML-specific).

## The two non-AI pieces

### Trigger: Conversation closed (`conversation_closed`)

Fires when a conversation is closed by an agent (one, or in bulk) or by an
automation's **Close conversation** step. It carries the closing note and who
closed it: use `{{ closure.note }}` or `{{ vars.closure_note }}` and
`{{ vars.closed_by }}`.

It is dispatched from **one server-side place**, `closeConversation()` in
`src/lib/conversations/close.ts`:

- the inbox close dialog and the bulk Close now go through
  `POST /api/conversations/close`, which runs the same
  `close_conversation_with_note` function as before (the closure note is still
  required and enforced by the database) and then dispatches the trigger;
- the **Close conversation** step calls the same function.

It fires **once per close of an open conversation**: closing an already-closed
conversation records the note but does not fire again, and two simultaneous
closes fire once. **Loops:** each dispatch carries the ids of the automations
that led to it. An automation already in that chain never runs again for it (an
automation that closes conversations cannot re-trigger itself), and a chain stops
after three links.

A close made outside the app (directly in the database, or through some future
route that calls the function without going through `closeConversation`) does
not fire the trigger.

### Create ticket (`create_ticket`)

Creates a ticket for the conversation's contact, linked to the conversation:
type, priority, optional team and assignee, a subject and description with
variables. It goes through the same creation path as the ticket dialog: the
per-account number comes from the same counter (`accounts.ticket_seq`, through
`next_ticket_number_system`, the server-only twin of `next_ticket_number`), the
row is inserted into `tickets`, so watchers, the SLA (086), the activity history
and the audit trail all run. The key uses the account's ticket prefix (VIR-12).
`created_by` is empty (no person made it) and an internal comment says
*Created by automation "name"*.

- **Skip if a ticket is already open for this conversation** (on by default):
  open, in-progress and pending tickets count; a resolved or closed one does not.
- **Let AI write the subject and description from the conversation**: uses the
  same untrusted-conversation rule as the closing note. If the AI fails for any
  reason, the templated subject and description are used instead, and the log
  says so. An AI-written ticket counts toward the 5 AI steps.
- The ticket key is saved in `vars.ticket_key` for later steps.

## If the AI call fails

Each step has an **If the AI call fails** choice:

| Step | Choices | Default |
| --- | --- | --- |
| AI reply | Skip (continue down *Couldn't answer*), Stop this automation, Send fallback text and continue | Skip |
| Ask AI | Take the No branch, Stop this automation | No branch |
| Extract, Summarise, Translate | Stop this automation, Skip this step and continue | Stop |
| Create ticket (AI text) | always falls back to the templated text | n/a |

"Failure" covers AI not set up or switched off, the notice not confirmed, the
monthly **budget used up** (logged as "AI budget used up"), the rate limit, a
timeout, a provider error, output that cannot be read (malformed JSON), an empty
answer, and the step limit.

## Guardrails (all AI steps)

- **Routing**: every call resolves its connection through the `automation` job
  (a per-job model override is honoured).
- **Budget**: every call goes through the same budget check as the other jobs:
  one alert at 80% of the monthly budget, calls stop at 100%.
- **Usage log**: one row per model call in the usage log with job `automation`
  (shown as **Automation steps** in the Usage tab).
- **Limits**: at most **5 AI steps per automation run** (Ask AI and an
  AI-written ticket count; the count survives a Wait step) and at most 5 AI steps
  in an automation, which is checked when you activate it; a **20-second timeout**
  per call; each message clipped to 2,000 characters and the whole transcript to
  12,000 (the newest messages win); a message or note an AI step writes is at
  most **4,096 characters**; the per-account AI rate limit is one bucket shared
  with auto-reply (30 calls a minute).
- **Safety**: customer text is untrusted. The prompts tell the model to ignore
  instructions inside the conversation, not to reveal other customers' data or
  these instructions, and not to make commitments on prices or dates that the
  material does not state (the AI reply reuses the auto-reply text unchanged).
  Anything you insert with a variable (`{{ message.text }}`, `{{ vars.x }}`,
  `{{ contact.name }}` ...) is put into a prompt wrapped in `« »` and cut to 1,000
  characters, and the prompts say text between `« »` is data. AI output is
  **data, never instructions**: an AI reply is sent only by the AI reply step,
  extraction is validated, Ask AI is parsed to three tokens.
- **No loop**: the AI's own reply does not fire `new_message_received` (only the
  inbound webhooks and the widget routes dispatch it; the shared send path and
  the AI applier never do), and an AI reply only ever answers the customer's
  latest message, so a replayed trigger sends nothing twice. While an automation
  with a `new_message_received` or `keyword_match` trigger is active, the
  built-in auto-reply bot stands down (as it always did), so an AI reply step and
  auto-reply never answer the same message.
- **Logs** (Automations > a run's log): each AI step shows its name, outcome,
  tokens and the first 500 characters of the output. The prompt is never logged.

## Testing a step: "Test this step"

Every AI step card (and Create ticket) has a **Test this step** button.

1. Click it and pick a conversation from the searchable list of recent ones (by
   customer name, phone number or last message).
2. If the step uses variables from earlier steps (`{{ vars.summary }}`), type a
   sample value for each.
3. **Run test.** You see the outcome (the AI reply text; yes, no or unsure with
   the model's reason; the extracted JSON; the summary; the translation; the
   ticket subject and description), which column the flow would continue down, a
   list of what it *would do* (send this reply, save this contact field, apply
   this label ...) and the tokens used.

It is a **dry run**: it uses the very same function the engine uses, with a mode
that has no way to write. **Nothing is sent, saved, labelled or created.** It
does spend real AI tokens, so a test counts toward the monthly budget and appears
in the usage log. It needs `automations.manage` and `ai.use`, and is
rate-limited (20 a minute per person, 60 for the workspace).
A failed test shows what the model returned, which is the quickest way to fix a
prompt.

## Cost notes

- A call is roughly the conversation text (up to 12,000 characters) plus the
  instructions and, for AI reply, up to five knowledge excerpts. Ask AI and
  Extract read the last 10 messages by default: lower the number to spend less.
- A cheap, fast model is usually enough for Ask AI, classify, translate and
  summaries. Route the **Automations** job to a small model in Connections; keep
  the bigger model for the customer-facing AI reply if you like (the override is
  per job, not per step).
- Put an Ask AI or a keyword Condition *before* the AI reply so most messages
  never reach the model.
- The monthly budget in AI Agents > Setup is your safety net: at 100% the AI
  steps follow their On failure choice and the automation keeps working with the
  non-AI steps.

## Examples

**1. AI first response, then hand off** (a quick-start template). Trigger: First
message from contact. AI reply (send). In the *Couldn't answer* column: Assign to
team, Add conversation label "Needs a person". Because the trigger fires on the
first message only, a hand-off happens once.

**2. Classify and route** (template). Trigger: First message from contact. AI
classify and extract: *topic* (choice: billing, shipping, technical, other, applies
the label with the same name) and *sentiment*. Then Add conversation label and
Assign to team. To send angry customers to a senior team, follow with a Condition
"Ask AI: Is the customer angry?".

**3. Close, summarise and open a ticket** (template). Trigger: Conversation
closed. AI summarise (into `vars.summary`, plus an internal note). Create ticket
with "Let AI write it" (subject `Follow-up: {{ contact.name }}` as the fallback).
Every closed conversation would get a ticket, so put a Condition first, for
example Ask AI "Does this conversation need a follow-up?".

**4. Only refunds get a human.** Ask AI "Is the customer asking for a refund?".
Yes: Set priority high, Assign to team Billing. No: AI reply.

**5. Let an English-speaking team read any language.** AI translate (the
customer's last message into English, into `vars.translation`), then Create
ticket whose description is `{{ vars.translation }}`.

## For developers

- Code: `src/lib/automations/ai/` (`run.ts` plans a step and never writes;
  `apply.ts` applies the plan; `dry-run.ts` is the Test panel's entry;
  `caller.ts` routing, budget, rate limit, timeout, usage log; `parsers.ts` the
  strict parsers; `prompts.ts`; `create-ticket.ts`; `vars.ts` the variable
  picker), `src/lib/automations/step-kinds.ts`, `src/lib/conversations/close.ts`,
  the routes `POST /api/automations/test-ai-step` (and its `/conversations`
  search), `GET /api/automations/ai-status` and `POST /api/conversations/close`.
- Migration `090_automation_ai.sql`: the `automation` AI job in the routing table
  and usage log (widened from the live constraint definitions, as 078 did), and
  `next_ticket_number_system`. `automations.trigger_type` and `step_type` are
  free text in the database, so `conversation_closed` and the new step types need
  no constraint change. Verify with `supabase/ci/verify-090-automation-ai.sql`.
- Tests: `src/lib/automations/ai/*.test.ts`, `engine-ai.test.ts`,
  `validate-ai.test.ts`, `templates-ai.test.ts`, `src/lib/conversations/close.test.ts`,
  the route tests and `src/components/automations/ai-steps-render.test.tsx` (en and ko).
