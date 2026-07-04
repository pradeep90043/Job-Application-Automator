// M6 verification against linkedin-mock.html:
// job 111 → Easy Apply through 3-step modal → applied
// job 222 → plain Apply → skipped as external ATS
// job 333 → Salesforce → skipped via skip list (deferred scoring after detail)
// puppeteer is ESM-only (v22+): loaded via dynamic import at the launch site
const path = require('path');
const http = require('http');
const fs = require('fs');

const EXT = path.resolve(__dirname);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(EXT, 'linkedin-mock.html')));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = await (await import('puppeteer')).default.launch({
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox']
  });

  const failures = [];
  const check = (ok, label) => {
    if (ok) console.log(`PASS: ${label}`);
    else { console.error(`FAIL: ${label}`); failures.push(label); }
  };

  try {
    await sleep(2000);
    const extId = (await browser.targets()).find(t => t.type() === 'service_worker').url().split('/')[2];
    const sidebar = await browser.newPage();
    sidebar.on('pageerror', err => console.error(`[Sidebar PageError] ${err.message}`));
    await sidebar.goto(`chrome-extension://${extId}/sidebar.html`);

    await sidebar.evaluate(() => new Promise(res => chrome.storage.local.set({
      userProfile: {
        name: 'Test User',
        skills: { 'React': 6, 'Node.js': 3 },
        currentCTC: '18 LPA', expectedCTC: '25 LPA', noticePeriod: '30',
        relocation: true, interviewAvailability: 'Virtual',
        applyList: ['react'],
        skipList: ['salesforce'],
        answers: { 'notice period': '30' }
      },
      appSettings: {
        mode: 'auto', matchThreshold: 70, applyDelayMs: 2000,
        maxApplicationsPerSession: 10, perJobTimeoutMs: 120000,
        confirmBeforeAuto: false, llm: {}
      },
      applicationHistory: [], agentState: null
    }, res)));
    await sidebar.reload(); await sleep(1500);

    const main = await browser.newPage();
    await main.goto(`http://localhost:${port}/linkedin-mock.html`);
    await main.bringToFront(); await sleep(1000);

    await sidebar.evaluate(() => {
      const i = document.getElementById('goalInput');
      i.value = 'mass apply';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('runBtn').click();
    });

    const started = Date.now();
    let done = null, lastLine = '';
    while (Date.now() - started < 300000) {
      const text = await sidebar.evaluate(() => document.getElementById('chatBox').innerText);
      const last = text.trim().split('\n').pop();
      if (last !== lastLine) { console.log(`[chat] ${last}`); lastLine = last; }
      if (text.includes('Session complete')) { done = text; break; }
      await sleep(2000);
    }
    check(!!done, 'LinkedIn mock session completed');

    const history = await sidebar.evaluate(() => new Promise(res =>
      chrome.storage.local.get(['applicationHistory'], r => res(r.applicationHistory || []))));
    history.forEach(r => console.log(`  [${r.status}] ${r.title} @ ${r.company} — ${r.reason}`));

    const byId = id => history.find(r => r.jobId === id);
    check(byId('111')?.status === 'applied', 'Easy Apply job (111) applied through 3-step modal');
    check(byId('222')?.status === 'skipped' && /external/i.test(byId('222')?.reason || ''),
      'plain-Apply job (222) skipped as external ATS');
    check(byId('333')?.status === 'skipped' && /skip list/i.test(byId('333')?.reason || ''),
      'Salesforce job (333) skipped via deferred scoring');
    check(history.every(r => r.source === 'linkedin'), 'records tagged with linkedin source');

    console.log(failures.length
      ? `\n--- LINKEDIN MOCK TEST FAILED (${failures.length}): ${failures.join('; ')} ---`
      : '\n--- LINKEDIN MOCK TEST PASSED ---');
    process.exitCode = failures.length ? 1 : 0;
  } catch (e) {
    console.error('Error:', e);
    process.exitCode = 1;
  } finally {
    server.close();
    await browser.close();
    process.exit(process.exitCode || 0);
  }
})();
