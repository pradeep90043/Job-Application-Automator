// test-real-dryrun.js - Run a DRY-RUN mass apply on the real Naukri listing.
// Scores jobs against the profile but clicks/submits/records nothing.
// Exits automatically when the dry run completes (or after a hard timeout).
// puppeteer is ESM-only (v22+): loaded via dynamic import at the launch site
const path = require('path');

const REAL_URL = process.argv[2] ||
  'https://www.naukri.com/react-js-jobs?k=react%20js&nignbevent_src=jobsearchDeskGNB';
const HARD_TIMEOUT_MS = 5 * 60 * 1000;

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

async function run() {
  const extensionPath = path.resolve(__dirname);
  const userDataDir = path.resolve(__dirname, '.chrome-profile');
  console.log('Extension path:', extensionPath);
  console.log('User data dir:', userDataDir);

  const browser = await (await import('puppeteer')).default.launch({
    headless: false,
    defaultViewport: null,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ],
    userDataDir
  });

  const exit = async (code, msg) => {
    if (msg) console.log(msg);
    try { await browser.close(); } catch (e) {}
    process.exit(code);
  };

  try {
    console.log('Waiting for extension service worker...');
    let sw = null;
    for (let i = 0; i < 15 && !sw; i++) {
      sw = (await browser.targets()).find(t => t.type() === 'service_worker');
      if (!sw) await new Promise(r => setTimeout(r, 1000));
    }
    if (!sw) return exit(1, '✕ Extension service worker never appeared.');
    const extId = sw.url().split('/')[2];
    console.log(`Extension ID: ${extId}`);

    const sidebarPage = await browser.newPage();
    await sidebarPage.goto(`chrome-extension://${extId}/sidebar.html`);

    const blank = (await browser.pages()).find(p => p.url() === 'about:blank');
    if (blank) await blank.close();

    // Seed profile only if missing; do NOT touch mode — the chat command
    // "mass apply dry run" forces dry-run regardless of stored settings.
    await sidebarPage.evaluate((profile) => new Promise(res => {
      chrome.storage.local.get(['userProfile'], (data) => {
        const sets = { agentState: null };
        if (!data.userProfile) sets.userProfile = profile;
        chrome.storage.local.set(sets, res);
      });
    }), SEED_PROFILE);

    console.log('Opening real Naukri listing:', REAL_URL);
    const mainPage = await browser.newPage();
    await mainPage.goto(REAL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await mainPage.bringToFront();
    await new Promise(r => setTimeout(r, 4000));

    // Login check (dry run works logged-out too, but note it)
    const loggedIn = await mainPage.evaluate(() => {
      // Logged-in header renders the profile drawer/avatar
      if (document.querySelector('.nI-gNb-drawer, [class*="nI-gNb-drawer"], .nI-gNb-info__sub-heading')) return true;
      // Logged-out header renders the Login button (footer links don't count)
      const loginBtn = document.querySelector('#login_Layer');
      if (!loginBtn) return true;
      const st = window.getComputedStyle(loginBtn);
      const r = loginBtn.getBoundingClientRect();
      return !(st.display !== 'none' && st.visibility !== 'hidden' && r.width > 5 && r.height > 5);
    }).catch(() => false);
    console.log(loggedIn ? '✓ Logged in to Naukri.' : '⚠ Not logged in (dry run still scores jobs).');

    console.log('Triggering: mass apply dry run');
    await sidebarPage.evaluate(() => {
      const input = document.getElementById('goalInput');
      input.value = 'mass apply dry run';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('runBtn').click();
    });

    const startedAt = Date.now();
    let printed = 0;
    while (Date.now() - startedAt < HARD_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, 2000));
      let logs = [];
      try {
        logs = await sidebarPage.evaluate(() =>
          Array.from(document.querySelectorAll('#chatBox .message'))
            .map(el => el.querySelector('.text')?.textContent || el.textContent));
      } catch (e) { continue; }

      for (; printed < logs.length; printed++) console.log(`[Chat] ${logs[printed]}`);

      const all = logs.join('\n');
      if (/Dry run complete/i.test(all)) {
        await mainPage.screenshot({ path: path.join(__dirname, 'dryrun-listing.png') }).catch(() => {});
        return exit(0, '\n✓ DRY RUN FINISHED (screenshot: dryrun-listing.png)');
      }
      if (/No jobs found on this page|not a supported job listing|No profile configured/i.test(all)) {
        await mainPage.screenshot({ path: path.join(__dirname, 'dryrun-listing.png') }).catch(() => {});
        return exit(2, '\n✕ DRY RUN ABORTED by pipeline (screenshot: dryrun-listing.png)');
      }
    }
    return exit(3, '\n✕ Hard timeout reached.');
  } catch (err) {
    console.error('Error:', err);
    return exit(1);
  }
}

run();
