# User Guide (`/help`) - maintainer notes

The User Guide is a GitBook-style help site that lives inside the CRM at `/help`
(sidebar item **User Guide**, visible to every signed-in role). It is written for
front-line agents. Admin setup (channels, roles, AI connections, automation
design) is out of scope: those pages say "ask your admin" and stop.

Pages are Markdown files in the repo, reviewed and released like code. There is
no database, no CMS and no external service.

## Where things live

| What | Where |
| --- | --- |
| Pages and sections | `content/help/<section>/<page>.md`, `content/help/<section>/_section.json` |
| Screenshots | `public/help/img/<file>.png` |
| Shot lists (what to capture) | `content/help/_shotlist-*.json` |
| Renderer, loader, search (no React) | `src/lib/help/` |
| Screens and components | `src/app/(dashboard)/help/`, `src/components/help/` |
| Article styles | `src/components/help/help.css` |
| Interface strings (search box, "On this page" ...) | `messages/en.json`, `messages/ko.json`, namespace `Help` |

## Add a page

1. Pick the section folder in `content/help/` (or add one, see below).
2. Create `content/help/<section>/<page-slug>.md`. The file name is the URL:
   `/help/<section>/<page-slug>`. Use lower-case letters, digits and hyphens.
3. Start the file with frontmatter:

   ```
   ---
   title: Reply to customers
   description: One sentence shown in search results and under the title.
   order: 2
   updated: 2026-09-21
   ---
   ```

   `title`, `description` and `order` are required. `order` is a whole number and
   must be unique inside the section. `updated` is optional (ISO date) and shows a
   "Last updated" line. Quotes are optional; a colon inside a description is fine.
4. Write the page in Markdown (see below). Link to other pages with
   `[text](/help/<section>/<page-slug>)` and to a heading with `#heading-id`.
5. Run `npx vitest run src/lib/help`. The content test fails on a missing or bad
   frontmatter, duplicate orders, broken `/help/...` links, unsupported HTML and
   screenshots that are neither on disk nor in a shot list.

Add a section: create `content/help/<section>/_section.json`

```json
{ "title": "Inbox", "order": 2, "description": "Shown on the guide home and section page." }
```

Sections and pages sort by `order`. The first section's first pages appear under
"Start here" on `/help`. A section with no valid pages is hidden.

## Markdown you can use

GitHub-flavoured Markdown: tables, task lists, fenced code (with a Copy button),
`##` and `###` headings (they get anchors and appear in "On this page"; a `#` in
the body is shown as `##` because the page title is the h1).

- **Numbered lists are steps** and are drawn as numbered circles. Start each step
  with a verb and name the exact button.
- **Callouts** are GitHub-style blockquotes: `> [!NOTE]`, `> [!TIP]`,
  `> [!WARNING]`, `> [!IMPORTANT]` (`[!CAUTION]` is shown as a warning). Put the
  text on the following lines, each starting with `>`. Use them sparingly.
- **Keys**: `<kbd>Ctrl</kbd>`. Raw HTML is limited to `kbd`, `br`, `sup`, `sub`,
  `mark`, `em`, `strong`, `b`, `i`, `u`, `s`, `code`, `small`, `details`,
  `summary`, and never keeps attributes. Anything else is removed and reported.
- **Links**: `/help/...` and `#anchor` links stay in the app; `http(s)`, `mailto`
  and `tel` links work; anything else (for example `javascript:`) is removed.
- **Images**: `![Alt text](/help/img/<page-slug>-<nn>-<what>.png)`. The alt text is
  shown as the caption, so write it as a short description. Images zoom on click.
  Only `/help/img/<kebab-case>.png` paths are allowed by the content test.

## Screenshots

- Name: `<page-slug>-<nn>-<what>.png`, kebab-case, for example
  `inbox-overview-01-list.png`. Put the file in `public/help/img/`.
- Every image a page uses must either exist in `public/help/img/` or be listed in a
  shot list, so an unfinished guide still passes the tests. Shot lists are JSON
  arrays in `content/help/_shotlist-<name>.json`:

  ```json
  [
    {
      "file": "inbox-overview-01-list.png",
      "page": "inbox/inbox-overview",
      "route": "/inbox",
      "capture": "Inbox with the Chats tab selected; one chat open. Nothing to click or type."
    }
  ]
  ```

  `page` is `<section>/<page-slug>` and must use `file`. Make `capture` precise
  (route, tab, what is open, what must not change): whoever captures it works only
  from that sentence and must not send, delete or edit anything.
- A missing screenshot never breaks the page: it shows a neutral placeholder with
  the alt text as caption (in development it also names the missing file).
- Capture with the browser window about 1280 px wide, light or dark to match the
  rest of the set, and blur or use demo data for real customer names and numbers.
  Save as PNG; keep files reasonably small (under about 400 KB).
- The page is built at release time, so add the PNG before building the release.

## How search works

There is no external service. `GET /help/search-index.json` (a route handler)
returns one document per page: title, section, description, headings and the
plain body text, produced by the same Markdown renderer as the pages. The browser
fetches it the first time search is opened and builds a small
[MiniSearch](https://lucaong.github.io/minisearch/) index (title is weighted
highest, then headings, description, body; prefix matching and light typo
tolerance; filler words such as "how" and "to" are ignored). Results show the
title, section and a snippet around the match, and are keyboard navigable.

Open search with `Ctrl+K` (or `Cmd+K`), or `/` when you are not typing in a field,
anywhere under `/help`. The guide home also has an inline search box.

## Robustness

The loader never throws on bad content. A page with broken frontmatter, or with a
file name that is not a slug, is skipped; a missing or invalid `_section.json` falls
back to the folder name; each problem is logged as `[help] ...` and returned as a
warning. The tests treat every warning as a failure, so mistakes are caught in CI
instead of shipping.

## Release and Docker

Pages are prerendered at `npm run build` (static, one HTML per page). The search
index route and the Markdown files are read from disk at run time, so the image
must contain `content/help`. This is ensured twice: `outputFileTracingIncludes` in
`next.config.ts` copies the files into `.next/standalone`, and the `Dockerfile`
copies `/app/content` into the runtime image. `public/help` ships with the rest of
`public/`. `.dockerignore` excludes `*.md` only at the repository root (Docker
ignore patterns are not recursive), so `content/help/**/*.md` is in the build
context; keep it that way.

Signed-out visitors to any `/help...` URL are redirected to `/login` by the
middleware, like the other app pages. The sidebar item has no capability and there
is no database capability for it: every signed-in role sees it.
