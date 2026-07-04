// test-real-apply-capped.js - LIVE auto-apply on real Naukri, capped at N
// applications (default 2). Forces auto mode, clears any stale session, and
// exits when the pipeline prints its session summary.
// puppeteer is ESM-only (v22+): loaded via dynamic import at the launch site
const path = require('path');

const REAL_URL = process.argv[2] ||
  'https://www.naukri.com/react-js-jobs?k=react%20js&nignbevent_src=jobsearchDeskGNB';
const APPLY_CAP = parseInt(process.argv[3], 10) || 2;
const HARD_TIMEOUT_MS = 30 * 60 * 1000;

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
  console.log(`Live apply run — cap: ${APPLY_CAP} application(s)`);

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

    // Force auto mode with the cap; clear stale session/agent state.
    await sidebarPage.evaluate((profile, cap) => new Promise(res => {
      chrome.storage.local.get(['userProfile', 'appSettings'], (data) => {
        chrome.storage.local.set({
          userProfile: data.userProfile || profile,
          appSettings: {
            ...(data.appSettings || {}),
            mode: 'auto',
            confirmBeforeAuto: false,
            maxApplicationsPerSession: cap,
            applyDelayMs: 5000,
            perJobTimeoutMs: 90000
          },
          agentState: null,
          massApplySession: null
        }, res);
      });
    }), SEED_PROFILE, APPLY_CAP);

    console.log('Opening Naukri listing:', REAL_URL);
    const mainPage = await browser.newPage();
    await mainPage.goto(REAL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await mainPage.bringToFront();
    await new Promise(r => setTimeout(r, 4000));

    const checkLogin = () => mainPage.evaluate(() => {
      if (document.querySelector('.nI-gNb-drawer, [class*="nI-gNb-drawer"], .nI-gNb-info__sub-heading')) return true;
      const loginBtn = document.querySelector('#login_Layer');
      if (!loginBtn) return true;
      const st = window.getComputedStyle(loginBtn);
      const r = loginBtn.getBoundingClientRect();
      return !(st.display !== 'none' && st.visibility !== 'hidden' && r.width > 5 && r.height > 5);
    }).catch(() => false);

    let loggedIn = await checkLogin();
    if (!loggedIn) {
      console.log('⚠ Not logged in — please log in in the browser window; waiting...');
      while (!loggedIn) {
        await new Promise(r => setTimeout(r, 3000));
        loggedIn = await checkLogin();
      }
    }
    console.log('✓ Logged in. Triggering: mass apply (auto)');

    await sidebarPage.evaluate(() => {
      const input = document.getElementById('goalInput');
      input.value = 'mass apply';
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
      if (/Session complete/i.test(all)) {
        await mainPage.screenshot({ path: path.join(__dirname, 'live-apply-final.png') }).catch(() => {});
        return exit(0, '\n✓ LIVE APPLY SESSION FINISHED (screenshot: live-apply-final.png)');
      }
      if (/No jobs found on this page|not a supported job listing|No profile configured/i.test(all)) {
        await mainPage.screenshot({ path: path.join(__dirname, 'live-apply-final.png') }).catch(() => {});
        return exit(2, '\n✕ ABORTED by pipeline (screenshot: live-apply-final.png)');
      }
    }
    await mainPage.screenshot({ path: path.join(__dirname, 'live-apply-final.png') }).catch(() => {});
    return exit(3, '\n✕ Hard timeout reached (screenshot: live-apply-final.png)');
  } catch (err) {
    console.error('Error:', err);
    return exit(1);
  }
}

run();
