# Doc Sign: sealing load notes

What it costs to seal a signed document, and what the cron job can carry. Read the next paragraph first.

**These numbers were measured on a developer machine, NOT on the live server.** Nothing was load tested on the live
server (no request, no seal, no `docker stats`). The live-server figures further down are estimates made by scaling
the developer-machine numbers with a stated factor, and they say so each time. The real PDF engine ran (pdf-lib, the
bundled fonts, the real certificate pages and the real PKCS#12 seal, then a read-back and a SHA-256 check). The only
fakes are the ones the service tests use: `FakeDb` for the database and storage (so no network time at all) and a mail
sender that does nothing.

## How it was run

From the repository root (PowerShell, Git Bash or cmd; the script bundles itself with the repo's esbuild because the
repository has no TypeScript runner):

```
npx esbuild scripts/sign-seal-benchmark.ts --bundle --platform=node --format=cjs --packages=external --outfile=build/sign-seal-benchmark.cjs && node --expose-gc build/sign-seal-benchmark.cjs --reps 8 --json seal-bench.json
```

`--only a,b,c` picks scenarios, `--batch 200` sets the size of the loop scenarios. Every scenario runs in a fresh
child process (`node --expose-gc`). A job is `runSealing(base, 1)`: claim, load, stamp the answers, append the
certificate pages, seal with a 2048-bit self-signed certificate (as the service makes the first one), store, read
back, verify, `sign_finish_sealing`, hand the mails over. RSS is sampled every 2 ms from a worker thread; heap and
external memory are sampled every 5 ms and at each database or storage call, so they are lower bounds (a long
synchronous stretch of the engine cannot be sampled). "Event loop stall" is how late a 10 ms timer ran: the longest
time the job kept the Node process from serving anything else.

## The machine

| | |
|---|---|
| CPU | 12th Gen Intel Core i7-1260P, 16 logical cores (boosts well above 4 GHz) |
| RAM | 31.7 GB |
| OS | Windows 11 Pro (10.0.26200), x64 |
| Node | v24.17.0 (the production image is `node:20-alpine`) |
| Load | not idle: other tools ran on it during the runs. A 4-page job measured 325 ms in a quiet moment and 390 to 650 ms during the full runs. The full-run medians are used below, so they are not flattering. A first full run gave the same picture within about 25 percent. |

## Results: one seal job

Warm = the median of 8 repeats in the same process (a long-lived server is warm). Cold = the first job in a fresh
process. Memory is for the process; "growth" is the cold run's peak RSS over the baseline taken just before it (the
baseline is about 105 to 125 MB here, mostly the benchmark itself, so growth is the figure that carries over).

| Scenario | Pages / fields / signers | Output | Cold ms | Warm ms (min to max) | Peak RSS MB (growth) | Peak heap / external MB | Event loop stall ms |
|---|---|---|---|---|---|---|---|
| a. small contract | 4 / 6 / 1 | 291 KB, 5 pp | 827 | **506** (388 to 540) | 151 (+46) | 91 / 33 | 197 |
| b. Merchant Application, form fully answered | 4 / 60 (40 print form answers) / 2 | 548 KB, 5 pp | 746 | **686** (447 to 753) | 161 (+47) | 95 / 23 | 205 |
| c. worst case: every answer fits | 50 / 300 / 1 | 620 KB, 52 pp | 1677 | **1988** (1819 to 2097) | 195 (+69) | 94 / 54 | 1050 |
| c-max. as c, a 400 KB image (the largest allowed) in all 50 signature fields | 50 / 300 / 1 | 780 KB | 2376 | **2644** (2437 to 2824) | 235 (+111) | 97 / 104 | 1790 |
| d. page ceiling | 190 / 300 / 1 | 980 KB, 192 pp | 2616 | **2809** (2711 to 3025) | 261 (+85) | 100 / 75 | 1124 |
| c-overflow. as c, but the 50 multi-line answers are 330 characters in a small box | 50 / 300 / 1 | 625 KB | 17 547 | **20 656** (2 runs) | 216 (+90) | 93 / 48 | 19 653 |
| c-overflow-max. the same with 2000-character answers (the most a multi-line answer may hold) | 50 / 300 / 1 | 627 KB | 135 343 | 135 343 (1 run) | 277 (+151) | 79 / 29 | 134 006 |

Limits used: 300 fields (`MAX_FIELDS`), 2000 characters per multi-line answer (`MAX_TEXT`), 400 KB per image
(`MAX_IMAGE_BYTES`), 200 pages (`MAX_PAGES`), 50 pages for a converted Word file (`MAX_CONVERTED_PAGES`). Every
sealed file was checked with `verifySealed` (valid in all scenarios). The base file of a, c and d is a fixture with about
45 lines of text per page; b is the real committed Merchant Application template. Each job makes 18 table queries,
2 rpc calls, 3 storage calls and 2 to 3 mails (23 network round trips plus the mails on the live server, none of them
in these numbers).

What the numbers say:

* A normal document costs about half a second of CPU and about 50 MB of extra memory. There is no single hot spot:
  deflate of the 300 KB output, the PKCS#12 parse and RSA signature in node-forge, and font embedding each take a share.
* A heavy but honest document (50 pages, 300 fields) costs about 2 s, and 2.6 s with maximum-size images.
* **A multi-line answer that does not fit its box is the real hazard.** The engine tries every font size from the
  largest down to 5 pt, re-measuring the whole text each time with full fontkit shaping (`fitText` and `wrapText` in
  `src/lib/sign/pdf/format.ts`), then cuts it. 50 such answers of 330 characters took 20 s, and of 2000 characters
  took 135 s, with the Node process stalled the whole time. A CPU profile shows the time is in fontkit (`applyLookup`,
  `getClassID`, `applyPositionValue`). Only answers bound to a form field are checked for fit at signing
  (`answer_does_not_fit`); the plain fields of a template are not, so a signer can send such answers.
* **A 199 or 200 page PDF can be sent but cannot be sealed.** The certificate adds 2 pages, and `sealPdf` re-opens the
  file with the 200 page cap, so 199 and 200 page documents fail every attempt (198 seals, tested) and end as
  failed after five tries.

### Fixed afterwards, in the security review (WP25)

The two hazards above were fixed in the engine, with tests (`src/lib/sign/pdf/engine-limits.test.ts`), and the same scenarios measured again
on the same machine (a quiet-ish moment; the unaffected scenarios a and c moved by the machine's own noise, about 10 percent):

| Scenario | Before (warm) | After (warm) | What changed |
|---|---|---|---|
| c-overflow, 50 answers of 330 characters | 20.7 s | 6.5 s | measured widths are kept per string and scaled by size (`stamp.ts`); a line wrap stops at the number of lines the box holds (`wrapText` `maxLines`) |
| c-overflow-max, 50 answers of 2000 characters | 135 s | 3.7 s | the same, and an answer that clearly cannot fit even at 5 pt is cut at once without trying every size (`clearlyTooLong`); the single-line cut halves instead of dropping a character at a time |
| 199 and 200 page document | could not be sealed | seals (tested at 200 pages, with the certificate pages) | the file is re-opened for sealing with room for the pages the engine adds (`SEAL_EXTRA_PAGES`) |

What is left: an answer that almost fits (so is not "clearly" too long) still takes the ordinary search, about 0.1 s each on this machine (about 0.3 s
on the assumed VPS); 300 such answers in one document would hold the process for about 30 s here, 90 s on the VPS, where before it was several minutes.
The sealing still runs on the web process's event loop (recommendation 5).

## Results: the cron loop over 200 documents

`runSealing(base, 2)` called until nothing is left, exactly the call `runAll` makes once a minute
(`src/lib/sign/service/jobs.ts`), over 200 documents that were completed and not yet sealed (FakeDb, so this is pure
engine time, with no waiting for the network):

| Documents | Ticks | Total | Per document | Tick of 2 (median, max) | Pure-CPU rate |
|---|---|---|---|---|---|
| 200 like (a) | 100 of 2 | 102.7 s | 513 ms | 1033, 1176 ms | 117 per minute |
| 200 like (b), 2 signers, form | 100 of 2 | 137.5 s | 687 ms | 1381, 1601 ms | 87 per minute |

The first and last ten ticks took the same time (no slowdown as the batch ran). Peak RSS reached 345 to 389 MB, but that
is the benchmark's: FakeDb keeps all 200 stored files in memory, which a real server does not.

**The configured rate is much lower than the engine's.** `runAll` seals at most 2 documents per tick and the tick runs
once a minute (`CRON_INTERVALS['sign-jobs'] = 60`), so the ceiling is 2 per minute, **120 per hour**, however fast the
CPU is. The loop above would take 100 minutes of real cron time. The job has no time budget of its own for sealing
(bulk send has 45 s); a document is claimed with a 300 s lease and five attempts.

## What 200 documents in one hour means for the VPS

Estimates, not measurements. The live server is one CPU and about a 1 GB share, and the Word converter container
(`sign-converter`, `cpus: 1`, `mem_limit: 1g`, see `docs/docker.md`) shares that CPU and memory when it runs.

**Factor assumed: 3 times the developer-machine CPU time** (a sensible range is 2 to 5).
Why 3: a laptop performance core near 4.5 GHz with a large cache against a shared vCPU at about 2 to 2.5 GHz (roughly
2 times on single-thread speed); Node 20 on Alpine (musl) against Node 24 on Windows; and the app, Next.js
serving, the OS and sometimes the converter taking turns on the one CPU. The memory-heavy parts (images, 50 MB peaks)
do not scale with CPU but compete for the 1 GB.

| One job | Dev machine (measured) | VPS CPU time (assumed 3x) | VPS event loop stall (3x) |
|---|---|---|---|
| a small contract | 0.5 s | about 1.5 s | about 0.6 s |
| b Merchant Application | 0.7 s | about 2 s | about 0.6 s |
| c, 50 pages and 300 fields | 2.0 s | about 6 s | about 3 s |
| c-max, 400 KB images | 2.6 s | about 8 s | about 5 s |
| c-overflow (330 characters) | 21 s | about 60 s | about 60 s |
| c-overflow-max (2000 characters) | 135 s | about 400 s, longer than the 300 s lease | about 400 s |

Add the waiting the benchmark leaves out. Assumed, not measured: about 30 ms for each of the 23 database and storage
round trips (about 0.7 s) and 0.3 to 0.8 s for each of the 2 to 3 mails the job sends one after another. A typical
document then takes about 3.5 to 4.5 s of wall time on the VPS, and a tick of 2 about 7 to 9 s, of which about 3 s is
CPU. Webhooks and automations for the event also run in the same process (the services call them inline or after
the response); they are not in these numbers either.

200 documents completed in one hour is 3.4 a minute:

* **CPU is not the limit; the batch size is.** At 2 a minute the job uses about 3 CPU-seconds a minute on typical
  documents (about 5 percent of the one CPU) and about 12 CPU-seconds on 50-page, 300-field documents (about 20
  percent). Even with the converter busy there is room.
* **The queue is.** With 200 documents arriving evenly in an hour and a capacity of 120, about 80 wait at the end of
  the hour and the last signer waits about 40 minutes more for the signed copy. If all 200 are signed at the same
  moment (a bulk batch answered together) the last one is sealed 100 minutes later. Nothing is lost: the documents
  show as finishing, and the mail goes out when each is sealed.
* **Memory:** a job adds about 45 to 110 MB to the process (more with large images). The live app's own size was not
  measured here (check `docker stats` on the server). One job at a time is fine in 1 GB; two in parallel with the
  converter running is not a safe assumption.
* **While a job runs the whole Node process is stuck**, web requests included, in stretches of about 0.2 s here and
  about 0.6 s on the VPS for a normal document, 3 to 5 s on the VPS for the heavy ones, and minutes for the overflow
  case above.

## Recommendations

Not applied; `jobs.ts` and the engine were not edited.

1. **Seal one at a time against a time budget, instead of claiming a fixed 2.** Replace the single
   `runSealing(base, 2)` in `runAll` with: claim 1, seal it, repeat while less than 20 s of the tick have passed, at
   most 4 documents (240 an hour, enough for 200). The bulk job already does this with `forEachWithinBudget`
   (`src/lib/cron/guard.ts`). Safe default: **budget 20 s, cap 4, concurrency 1.** On the assumed VPS that is 4 typical
   documents or 2 heavy ones a tick, about 10 percent of the CPU. Do not seal in parallel inside the process: the work
   is CPU-bound on one event loop, so parallel only multiplies peak memory (about 110 MB each) and the stalls.
2. **Claim just before sealing.** Claiming 2 up front starts the 300 s lease of the second document while the first is
   still being sealed; if a heavy first document runs long, the second can be claimed again by the next minute's tick
   while it has not started. Claim-one-then-seal fixes that. Consider a 600 s lease, or one document per claim with the
   lease renewed, because tick overlap is possible (the cron route has no lock and the next minute starts regardless).
3. **DONE in WP25 (see "Fixed afterwards"). Fix the overflow cost in the engine (the largest real risk found).** In `fitText`, skip the size search when the
   text cannot fit even at the 5 pt floor (a cheap area estimate), measure each word once instead of re-measuring the
   growing line, and shape a string once and scale the width by the font size. Also consider refusing, at signing, a plain
   field answer that cannot fit its box, as is already done for form-bound answers. Until then a signer can occupy the
   server for minutes with 50 long answers; that deserves a second pair of eyes from whoever is reviewing security.
4. **DONE in WP25 (the second way: `sealPdf` opens the file with room for the certificate pages). Fix the 199 and 200 page case:** lower the upload and send limit to 198 pages, or let `sealPdf` open files with
   a higher cap than the upload limit (certificate pages are added after the check).
5. **Watch it.** The cron heartbeat stores `duration_ms` for `sign-jobs`. Alert when a tick takes more than 45 s, and
   look at the oldest document still in "sealing". For a bigger headroom later, the sealing could move to a worker thread
   so web requests are not stalled (not needed at 200 an hour).
6. **Measure on the server before relying on any of this.** The cheapest honest check is one real seal on the
   VPS with `docker stats` open and the time recorded in the heartbeat (`duration_ms`), then replacing the factor of 3
   above with the measured ratio.

## What was not measured

The live server (CPU, memory, disk, Node 20 on Alpine, the Next bundle); network time to Supabase, storage and the mail
provider; the converter; concurrent web traffic; webhooks and automations beyond one empty lookup; documents with a
CJK font (the fonts written on documents are Latin only today); the sealing of a document collection's documents; a certificate
uploaded by a workspace (a larger chain makes a larger signature, the same order of cost). The run-to-run spread
was up to about 25 percent between the two full runs, wider than usual because of the machine's other load.
