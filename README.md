# Job Application Automator

A Chrome (Manifest v3) extension that mass-applies to jobs on **Naukri** and
**LinkedIn** using a self-hosted LLM. You set up a profile once; the extension
scans a job-listing page, scores each job against your skills and criteria,
fills the application forms, and submits — with dry-run, manual-review, and
fully-automatic modes.

A general-purpose AI browser agent (chat) is still included and is used as a
fallback whenever the deterministic pipeline hits a form it doesn't recognize.

> ⚠️ **Use responsibly.** Automated applying can violate Naukri's and
> LinkedIn's Terms of Service and may get an account restricted. Dry-run is the
> default mode. Start there, review the matches, and only enable Auto once
> you're confident. You are responsible for what gets submitted under your name.

---

## Setup

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   and select this folder.
2. Click the extension icon to open the side panel.
3. Click the **⚙ gear** and fill in your profile:
   - **Skills** — one per line as `skill : years` (e.g. `React : 6`)
   - **Current / Expected CTC**, **Notice period**, **Relocation**, **Availability**
   - **Apply keywords** — jobs mentioning these are always considered a match
   - **Skip keywords** — jobs mentioning these are rejected without an LLM call
   - **Canned answers** — one per line as `question keyword = answer`
     (e.g. `react experience = 6`), used to auto-fill recruiter questions
   - **LLM backend** — base URL, API key, model (defaults are pre-filled)

The LLM endpoint is an OpenAI-compatible server at
`http://92.4.82.192:3001/v1/chat/completions` by default.

---

## Usage

Open a **Naukri** or **LinkedIn Jobs** search/listing page, then in the side panel:

- Pick a mode in the top bar: **Dry run** (score only), **Manual** (approve each),
  or **Auto** (apply automatically), and click **▶ Mass Apply**.
- Or type a command in the chat box:
  - `mass apply` — run in the currently selected mode
  - `mass apply dry run` — force a dry run
  - `resume` — continue an interrupted session
  - `history` — show recent applications
  - anything else — talk to the general AI browser agent

The pipeline scores jobs (skip-list → apply-list → LLM), opens each match,
fills the form from your profile (falling back to the LLM for free-text
questions, and to the AI agent for anything unrecognized), submits, and records
the result. Jobs already in your history are skipped. A summary
(`Applied | Skipped | Failed`) is printed at the end.

### Safety features
- Dry-run default, confirmation before Auto, configurable delay between applies,
  per-session application cap, per-job timeout, and a **Stop** button.
- A stopped session can be resumed later; completed jobs are never re-applied.

---

## Architecture

```
manifest.json          Extension config (side panel + content script)
background.js          Opens the side panel
content.js             Page DOM extraction for the fallback AI agent
sidebar.html/.js       Chat UI, command router, LLM step-agent loop
js/config.js           CONFIG (LLM, thresholds, delays) + shared JA namespace
js/storage.js          Profile / settings / history / session + dedup keys
js/llm.js              LLM client, scoreJob(), generateAnswer(), agent prompt
js/actions.js          executeAction() browser primitives + nav/CAPTCHA helpers
js/form-filler.js      Form-step scraping, answer resolution, filling
js/sites/naukri.js     Naukri handler (also drives naukri-mock.html)
js/sites/linkedin.js   LinkedIn Easy Apply handler
js/pipeline.js         Mass-apply state machine, session, summary
js/settings-ui.js      Settings modal + mode bar
```

Two engines share one action layer: a **deterministic pipeline** (primary) and
the **LLM step-agent loop** (fallback for unknown forms). Site handlers run from
the side panel via `chrome.scripting.executeScript`.

---

## Testing

Puppeteer harnesses run against local mock portals (no real accounts needed):

```
node test-naukri.js        # general AI agent applies through the Naukri mock
node test-mass-apply.js    # pipeline: dry-run + auto + dedup (naukri-mock.html)
```

`naukri-mock.html` (`?variant=custom` adds a select + free-text step) and
`linkedin-mock.html` back the automated tests. Real-site runs should always
start in dry-run; `CONFIG.stopBeforeSubmit` halts LinkedIn Easy Apply right
before the final submit for safe inspection.
