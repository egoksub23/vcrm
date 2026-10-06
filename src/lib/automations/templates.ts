import type {
  AutomationStepConfig,
  AutomationStepType,
  AutomationTriggerConfig,
  AutomationTriggerType,
} from '@/types'

export type TemplateSlug =
  | 'welcome_message'
  | 'out_of_office'
  | 'lead_qualifier'
  | 'follow_up_reminder'
  // AI quick-starts (docs/automation-ai.md). Ids are stable: they are in the
  // `?template=` link and the API's `template` field.
  | 'ai_first_response'
  | 'ai_classify_route'
  | 'ai_close_summary_ticket'
  // Doc Sign recipes (docs/automations-and-cron.md). Offered where Doc Sign is on.
  | 'merchant_onboarding'
  | 'merchant_signed_followup'

export interface TemplateStepSeed {
  step_type: AutomationStepType
  step_config: AutomationStepConfig
  branch?: 'yes' | 'no' | null
  /** Index (within this seed list) of the Condition / AI reply parent, if nested. */
  parent_index?: number | null
  /**
   * Text the builder localises when it starts from this template: config key
   * -> key under `Automations.templates.<slug>.seed` in the message catalogue.
   * `step_config` keeps an English default, which is what the API path stores.
   */
  i18n?: Record<string, string>
}

export interface AutomationTemplateDefinition {
  slug: TemplateSlug
  name: string
  description: string
  trigger_type: AutomationTriggerType
  trigger_config: AutomationTriggerConfig
  steps: TemplateStepSeed[]
}

export const AUTOMATION_TEMPLATES: Record<TemplateSlug, AutomationTemplateDefinition> = {
  welcome_message: {
    slug: 'welcome_message',
    name: 'Welcome Message',
    description: 'Auto-reply to first-time contacts with a greeting.',
    // first_inbound_message (added in PR #33) catches both brand-new
    // contacts AND manually-added/imported contacts on their first-ever
    // reply, which is what a user setting up a "welcome" automation
    // almost always wants. new_contact_created would miss the
    // manually-imported case.
    trigger_type: 'first_inbound_message',
    trigger_config: {},
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: "Hi! 👋 Thanks for reaching out. We'll get back to you shortly.",
        },
      },
      {
        step_type: 'add_tag',
        step_config: { tag_id: '' },
      },
    ],
  },
  out_of_office: {
    slug: 'out_of_office',
    name: 'Out of Office',
    description: 'Auto-reply during off-hours so nobody is left waiting.',
    trigger_type: 'new_message_received',
    trigger_config: {},
    steps: [
      {
        step_type: 'condition',
        step_config: {
          subject: 'time_of_day',
          operand: '18:00-09:00',
        },
      },
      {
        step_type: 'send_message',
        step_config: {
          text:
            "Thanks for your message! Our team is offline right now (9am–6pm) and will reply first thing tomorrow.",
        },
        parent_index: 0,
        branch: 'yes',
      },
    ],
  },
  lead_qualifier: {
    slug: 'lead_qualifier',
    name: 'Lead Qualifier',
    description: 'Ask qualification questions to filter inbound leads.',
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: ['pricing', 'quote', 'buy'],
      match_type: 'contains',
    },
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text:
            "Great — happy to help with pricing! Quick question: roughly how many seats are you looking for?",
        },
      },
      {
        step_type: 'wait',
        step_config: { amount: 10, unit: 'minutes' },
      },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
      },
    ],
  },
  follow_up_reminder: {
    slug: 'follow_up_reminder',
    name: 'Follow-up Reminder',
    description: 'Send a nudge if a contact has not replied within 24 hours.',
    trigger_type: 'new_message_received',
    trigger_config: {},
    steps: [
      {
        step_type: 'wait',
        step_config: { amount: 1, unit: 'days' },
      },
      {
        step_type: 'send_message',
        step_config: {
          text:
            "Just circling back — did you have any other questions for us? Happy to help!",
        },
      },
    ],
  },
  // 1. The AI answers the customer's first message from the knowledge base; if
  //    it cannot, a person takes over. Fires once per contact (first message),
  //    so a hand-off is not repeated on every later message.
  ai_first_response: {
    slug: 'ai_first_response',
    name: 'AI first response, then hand off',
    description: 'The AI answers the first message from your knowledge base. If it cannot, the conversation goes to a team.',
    trigger_type: 'first_inbound_message',
    trigger_config: {},
    steps: [
      {
        step_type: 'ai_reply',
        step_config: {
          mode: 'send',
          language: 'match',
          instructions: 'Be friendly and concise. Do not promise refunds, prices or delivery dates.',
          on_failure: 'skip',
        },
        i18n: { instructions: 'aiReplyInstructions' },
      },
      // "Couldn't answer" column: hand off and mark it. Pick the team and label.
      { step_type: 'assign_to_team', step_config: { team_id: '', mode: 'round_robin' }, parent_index: 0, branch: 'no' },
      { step_type: 'add_conversation_label', step_config: { tag_id: '' }, parent_index: 0, branch: 'no' },
    ],
  },
  // 2. Classify the first message (topic and sentiment), apply the label named
  //    like the topic, and route it.
  ai_classify_route: {
    slug: 'ai_classify_route',
    name: 'Classify and route',
    description: 'The AI reads the first message for its topic and mood, labels the conversation and routes it to a team.',
    trigger_type: 'first_inbound_message',
    trigger_config: {},
    steps: [
      {
        step_type: 'ai_extract',
        step_config: {
          fields: [
            {
              key: 'topic',
              description: "What the customer's message is mainly about",
              type: 'choice',
              choices: ['billing', 'shipping', 'technical', 'other'],
              // Applies the existing label with the same name as the answer.
              target: { kind: 'label' },
            },
            {
              key: 'sentiment',
              description: "The customer's overall mood in their messages",
              type: 'choice',
              choices: ['positive', 'neutral', 'negative'],
              target: null,
            },
          ],
          on_failure: 'skip',
        },
      },
      { step_type: 'add_conversation_label', step_config: { tag_id: '' } },
      { step_type: 'assign_to_team', step_config: { team_id: '', mode: 'least_loaded' } },
    ],
  },
  // 3. When a conversation is closed: summarise it, note it, and open a ticket
  //    written by the AI (skipped if one is already open for the conversation).
  ai_close_summary_ticket: {
    slug: 'ai_close_summary_ticket',
    name: 'Close, summarise and open a ticket',
    description: 'When a conversation is closed, the AI summarises it and opens a ticket for the follow-up.',
    trigger_type: 'conversation_closed',
    trigger_config: {},
    steps: [
      { step_type: 'ai_summarize', step_config: { save_to: 'summary', post_note: true, on_failure: 'skip' } },
      {
        step_type: 'create_ticket',
        step_config: {
          category: 'general',
          priority: 'normal',
          subject: 'Follow-up: {{ contact.name }}',
          description: '{{ vars.summary }}',
          ai_write: true,
          skip_if_open: true,
        },
        i18n: { subject: 'ticketSubject' },
      },
      { step_type: 'add_conversation_label', step_config: { tag_id: '' } },
    ],
  },
  // Doc Sign recipe 1. A contact gets the tag (a form, an agent or another automation adds it), the Merchant
  // Application goes to them for signing. Two pickers are left for the person who starts from the recipe: the
  // tag and the template. `tag_hint` / `template_hint` are the names the builder looks for and picks when the
  // workspace has them ("Merchant applicant", and the "Merchant Application" template the add-on installs);
  // they are ignored by the engine and by validation.
  merchant_onboarding: {
    slug: 'merchant_onboarding',
    name: 'Merchant onboarding',
    description: 'When a contact is tagged "Merchant applicant", send them the Merchant Application to fill in and sign.',
    trigger_type: 'tag_added',
    trigger_config: { tag_id: '', tag_hint: 'Merchant applicant' },
    steps: [
      {
        step_type: 'send_sign_document',
        step_config: {
          template_id: '',
          template_hint: 'Merchant Application',
          title: '',
          recipients: [{ role_key: 'merchant', source: 'contact', channel: 'email' }],
          merge_values: {},
          send: true,
        },
      },
    ],
  },
  // Doc Sign recipe 2. The other half: when a Merchant Application is signed, mark the contact, open the KYC
  // review for the team, and thank the merchant. The welcome message goes last: it needs an existing
  // conversation with the contact, and the first two steps must not depend on that.
  merchant_signed_followup: {
    slug: 'merchant_signed_followup',
    name: 'Merchant signed follow-up',
    description: 'When a Merchant Application is signed, tag the contact "Merchant signed", open a KYC review ticket and send a thank-you.',
    trigger_type: 'sign_document_event',
    trigger_config: { events: ['completed'], template_id: '', template_hint: 'Merchant Application' },
    steps: [
      { step_type: 'add_tag', step_config: { tag_id: '', tag_hint: 'Merchant signed' } },
      {
        step_type: 'create_ticket',
        step_config: {
          category: 'account',
          priority: 'normal',
          subject: 'Merchant KYC review',
          description:
            'The Merchant Application {{ sign.reference }} from {{ contact.name }} is signed. Check the company details and the documents, then confirm the file is genuine: {{ sign.verify_url }}',
          // a signed document is not a conversation: always open the review
          skip_if_open: false,
        },
        i18n: { subject: 'ticketSubject', description: 'ticketDescription' },
      },
      {
        step_type: 'send_message',
        step_config: {
          text: 'Thank you {{ contact.name }}. We have received your signed Merchant Application ({{ sign.reference }}). Our team will review it and be in touch shortly.',
        },
        i18n: { text: 'welcomeMessage' },
      },
    ],
  },
}

export function getTemplate(slug: string): AutomationTemplateDefinition | null {
  return AUTOMATION_TEMPLATES[slug as TemplateSlug] ?? null
}
