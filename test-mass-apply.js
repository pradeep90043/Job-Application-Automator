// test-mass-apply.js - Puppeteer test for the deterministic mass-apply pipeline.
// Phases: A) dry run (score only, nothing clicked)  B) auto apply  C) dedup re-run.
// puppeteer is ESM-only (v22+): loaded via dynamic import at the launch site
const path = require('path');
const http = require('http');
const fs = require('fs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const SEED_PROFILE = {
  name: 'Test User',
  skills: { 'React': 6, 'Node.js': 3, 'TypeScript': 6 },
  currentCTC: '18 LPA',
  expectedCTC: '25 LPA',
  noticePeriod: '30',
  relocation: true,
  interviewAvailability: 'Virtual',
  applyList: ['react', 'mern', 'node'],
  skipList: ['jquery', 'vue'],
  answers: { 'notice period': '30', 'react experience': '6' }
};

const SEED_SETTINGS = {
  mode: 'auto',
  matchThreshold: 70,
  applyDelayMs: 2000,
  maxApplicationsPerSession: 10,
  perJobTimeoutMs: 90000,
  confirmBeforeAuto: false,
  llm: {}
};

async function runTest() {
  const extensionPath = path.resolve(__dirname);

  const server = http.createServer((req, res) => {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(path.resolve(__dirname, 'naukri-mock.html')));
    } catch (e) {
      res.writeHead(500); res.end('Error reading naukri-mock.html');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`Mock portal at http://localhost:${port}/naukri-mock.html`);

  const browser = await (await import('puppeteer')).default.launch({
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox', '--disable-setuid-sandbox'
    ]
  });

  const failures = [];
  const check = (ok, label) => {
    if (ok) console.log(`PASS: ${label}`);
    else { console.error(`FAIL: ${label}`); failures.push(label); }
  };

  try {
    await sleep(2000);
    const sw = (await browser.targets()).find(t => t.type() === 'service_worker');
    if (!sw) throw new Error('Extension service worker not found');
    const extId = sw.url().split('/')[2];

    const sidebarPage = await browser.newPage();
    sidebarPage.on('pageerror', err => console.error(`[Sidebar PageError] ${err.message}`));
    await sidebarPage.goto(`chrome-extension://${extId}/sidebar.html`);

    const pages = await browser.pages();
    const blank = pages.find(p => p.url() === 'about:blank');
    if (blank) await blank.close();

    // Seed profile/settings, clear history + agent state
    await sidebarPage.evaluate((profile, settings) => new Promise(res =>
      chrome.storage.local.set({
        userProfile: profile,
        appSettings: settings,
        applicationHistory: [],
        agentState: null
      }, res)), SEED_PROFILE, SEED_SETTINGS);
    await sidebarPage.reload();
    await sleep(1500);

    const mainPage = await browser.newPage();
    const listingUrl = `http://localhost:${port}/naukri-mock.html?page=listing`;
    await mainPage.goto(listingUrl);
    await mainPage.bringToFront();
    await sleep(1000);

    const chatText = () => sidebarPage.evaluate(() =>
      document.getElementById('chatBox').innerText);

    const runCommand = async (cmd) => {
      await sidebarPage.evaluate((c) => {
        const input = document.getElementById('goalInput');
        input.value = c;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('runBtn').click();
      }, cmd);
    };

    const waitForChat = async (needle, timeoutMs) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const text = await chatText();
        if (text.includes(needle)) return text;
        await sleep(1500);
      }
      return null;
    };

    const getHistory = () => sidebarPage.evaluate(() => new Promise(res =>
      chrome.storage.local.get(['applicationHistory'], r => res(r.applicationHistory || []))));

    // ── Phase A: dry run ─────────────────────────────────────────────
    console.log('\n--- Phase A: dry run ---');
    await runCommand('mass apply dry run');
    const dryText = await waitForChat('Dry run complete', 90000);
    check(!!dryText, 'dry run completed');
    if (dryText) {
      const wouldApply = (dryText.match(/WOULD APPLY/g) || []).length;
      check(wouldApply === 4, `4 would-apply jobs (got ${wouldApply})`);
      check(/skip list: jquery/i.test(dryText), 'jQuery job skipped via skip list');
      check(/skip list: vue/i.test(dryText), 'Vue job skipped via skip list');
    }
    check((await mainPage.evaluate(() => location.href)).includes('page=listing'),
      'dry run never left the listing page');
    check((await getHistory()).length === 0, 'dry run recorded nothing to history');

    // ── Phase B: auto apply ──────────────────────────────────────────
    console.log('\n--- Phase B: auto apply ---');
    await mainPage.bringToFront();
    await runCommand('mass apply');

    // Progress logging while the session runs
    const started = Date.now();
    let done = null;
    let lastLogged = '';
    while (Date.now() - started < 300000) {
      const text = await chatText();
      const lines = text.trim().split('\n');
      const last = lines[lines.length - 1];
      if (last !== lastLogged) { console.log(`[chat] ${last}`); lastLogged = last; }
      if (text.includes('Session complete')) { done = text; break; }
      await sleep(2000);
    }
    check(!!done, 'auto session completed with summary');

    const history = await getHistory();
    const applied = history.filter(r => r.status === 'applied');
    const skipped = history.filter(r => r.status === 'skipped');
    const failed = history.filter(r => r.status === 'failed');
    console.log(`History: ${applied.length} applied, ${skipped.length} skipped, ${failed.length} failed`);
    history.forEach(r => console.log(`  [${r.status}] ${r.title} @ ${r.company} — ${r.reason}`));

    check(applied.length >= 2, `applied to >=2 jobs (got ${applied.length})`);
    check(!applied.some(r => r.jobId === '7890'), 'jQuery job (7890) was never applied to');
    check(!applied.some(r => r.jobId === '3456'), 'Vue job (3456) was never applied to');
    check(skipped.some(r => r.jobId === '7890'), 'jQuery job recorded as skipped');

    // ── Phase C: dedup on re-run ─────────────────────────────────────
    console.log('\n--- Phase C: dedup re-run ---');
    await mainPage.goto(listingUrl);
    await mainPage.bringToFront();
    await sleep(1000);
    const historyBefore = (await getHistory()).length;
    await runCommand('mass apply');
    const dedupText = await waitForChat('already in your application history', 60000);
    check(!!dedupText, 'second run reports all jobs already processed');
    check((await getHistory()).length === historyBefore, 'second run added no history records');

    console.log(failures.length
      ? `\n--- TEST FAILED (${failures.length}): ${failures.join('; ')} ---`
      : '\n--- MASS APPLY TEST PASSED ---');
    process.exitCode = failures.length ? 1 : 0;

  } catch (err) {
    console.error('Error during test execution:', err);
    process.exitCode = 1;
  } finally {
    try { server.close(); await browser.close(); } catch (e) {}
    process.exit(process.exitCode || 0);
  }
}

runTest();
