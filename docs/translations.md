# Languages

The app is offered in English, Korean, Bahasa Melayu (`ms`) and Simplified Chinese (`zh`). The
choice is made per request: the person's own setting (Settings > Your profile), then their
workspace's (Settings > Workspace), then the deployment default (`NEXT_PUBLIC_APP_LOCALE`), then
English. Codes live in `src/lib/i18n/locales.ts`.

## How a translation file works

`messages/<code>.json` is laid over `messages/en.json` at request time
(`src/i18n/request.ts`), so a key that is missing shows its English text, never a raw key path.
`src/i18n/messages.test.ts` holds `ko`, `ms` and `zh` to the English keys and to the same
`{placeholders}`, plural structure and `<tags>`.

`ms` and `zh` deliberately leave out the namespaces customers never see: `Jira`, `Incidents`,
`Platform`, `Settings.jira`, `Settings.incidents` (Vircle's own tools and the operator console).
They stay in English.

## Adding a language

1. Add `messages/<code>.json` (translate everything except the namespaces above, or all of it).
2. Add the code to `SUPPORTED_LOCALES` and its name, written in itself, to `LOCALE_NAMES` in
   `src/lib/i18n/locales.ts`.
3. Add the code to `TRANSLATED_LOCALES` in `src/i18n/messages.test.ts`.

A regional code (`zh-TW`, `pt-BR`) is read as its base language (`zh`, `pt`): there is one file per
base language. Traditional Chinese would need its own code and file.

## Review status

`ms` and `zh` were drafted by machine against a fixed glossary (below) and have NOT been reviewed by
a native speaker. Before customers rely on them, have each read through the screens they use most
(Inbox, Contacts, Broadcasts, Tickets, Settings). Points a translator flagged:

- **Glossary choices to confirm.** Malay: Inbox = Peti Masuk, Ticket = Tiket, Workspace = Ruang kerja,
  Pipeline = Saluran jualan, Deal = Tawaran, Agent = Ejen. Chinese: Ticket = 工单, Broadcast = 群发,
  Pipeline = 销售管道, Deal = 商机, Agent = 客服 (AI agents = AI 智能体 in the automation screens).
- **Chinese "Pending" is 挂起** from the glossary, which reads oddly for approvals ("awaiting
  approval"); 待审批 would be more natural there.
- **Tag vs label in Chinese** are both 标签 in the glossary; a few strings use 标注 for snippets or
  labels so the two stay apart.
- **Sembang** is the name of the team chat. Malay "sembang" is also the word for "chat", and a few
  Malay strings (inbox "Chats", "Web chat") use the word; check they do not read as the product.
- **Menu paths** quoted inside help text ("Settings → Audit") were written from the glossary and
  should match the real page titles in that language.
- **Sample data** in placeholders is localised in places (Malay and Chinese names and phone
  numbers); revert to the English samples if preferred.
- **Not translated on purpose:** CSV column names and commands, brand and product names, and Meta's
  own screen labels quoted in setup steps.
