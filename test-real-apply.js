// test-real-apply.js - Launcher to run mass apply automatically on Naukri with persistent profile.
// puppeteer is ESM-only (v22+): loaded via dynamic import at the launch site
const path = require('path');

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
  mode: 'auto', // Auto apply mode
  matchThreshold: 70,
  applyDelayMs: 3000,
  maxApplicationsPerSession: 10,
  perJobTimeoutMs: 90000,
  confirmBeforeAuto: false,
  llm: {}
};

async function runRealApply() {
  const extensionPath = path.resolve(__dirname);
  const userDataDir = path.resolve(__dirname, '.chrome-profile');
  console.log('Extension path:', extensionPath);
  console.log('User data directory (persistent session):', userDataDir);

  try {
    const browser = await (await import('puppeteer')).default.launch({
      headless: false,
      defaultViewport: null,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ],
      userDataDir: userDataDir
    });

    console.log('Waiting for extension service worker to initialize...');
    let sw = null;
    for (let i = 0; i < 10; i++) {
      const targets = await browser.targets();
      console.log(`Targets: ${targets.map(t => `${t.type()}: ${t.url()}`).join(', ')}`);
      sw = targets.find(t => t.type() === 'service_worker');
      if (sw) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!sw) {
      throw new Error('Could not find extension service worker after waiting.');
    }
    const extId = sw.url().split('/')[2];
    console.log(`Extension ID: ${extId}`);

    // Open sidebar page
    console.log('Opening extension sidebar...');
    const sidebarPage = await browser.newPage();
    await sidebarPage.goto(`chrome-extension://${extId}/sidebar.html`);

    // Close blank tab
    const pages = await browser.pages();
    const blankPage = pages.find(p => p.url() === 'about:blank');
    if (blankPage) await blankPage.close();

    // Setup settings: force Auto Mode and confirmBeforeAuto = false
    await sidebarPage.evaluate((profile, settings) => new Promise(res => {
      chrome.storage.local.get(['userProfile', 'appSettings'], (data) => {
        const mergedProfile = data.userProfile || profile;
        const mergedSettings = { ...(data.appSettings || settings), mode: 'auto', confirmBeforeAuto: false };
        
        chrome.storage.local.set({
          userProfile: mergedProfile,
          appSettings: mergedSettings,
          agentState: null // reset agent state to start fresh
        }, res);
      });
    }), SEED_PROFILE, SEED_SETTINGS);

    // Open Naukri page
    console.log('Opening Naukri job listings...');
    const mainPage = await browser.newPage();
    const realUrl = 'https://www.naukri.com/react-js-jobs?k=react%20js&nignbevent_src=jobsearchDeskGNB';
    await mainPage.goto(realUrl);
    await mainPage.bringToFront();

    // Check if user is logged in
    const checkLoginStatus = async () => {
      return await mainPage.evaluate(() => {
        // Logged-in header renders the profile drawer/avatar
        if (document.querySelector('.nI-gNb-drawer, [class*="nI-gNb-drawer"], .nI-gNb-info__sub-heading')) return true;
        // Logged-out header renders the Login button (footer links don't count)
        const loginBtn = document.querySelector('#login_Layer');
        if (!loginBtn) return true;
        const style = window.getComputedStyle(loginBtn);
        const rect = loginBtn.getBoundingClientRect();
        const isVisible = style.display !== 'none' &&
                          style.visibility !== 'hidden' &&
                          rect.width > 5 &&
                          rect.height > 5;
        return !isVisible;
      });
    };

    let loggedIn = await checkLoginStatus();
    if (!loggedIn) {
      console.log('\n================================================================');
      console.log('⚠️ Please LOGIN to your Naukri account in the browser window.');
      console.log('The script will wait for you to log in before starting mass-apply.');
      console.log('================================================================\n');

      // Poll until logged in
      let lastLoggedUrl = '';
      while (!loggedIn) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const currentUrl = await mainPage.evaluate(() => window.location.href);
          if (currentUrl !== lastLoggedUrl) {
            console.log(`[Browser Info] Current page: ${currentUrl}`);
            lastLoggedUrl = currentUrl;
          }
          loggedIn = await checkLoginStatus();
        } catch (e) {
          // Tab might be navigating during login
        }
      }
      console.log('✓ Login detected! Starting application pipeline...');
    } else {
      console.log('✓ Already logged in. Starting application pipeline...');
    }

    // Ensure we are on the listings page after login
    const currentUrl = await mainPage.evaluate(() => window.location.href);
    if (!currentUrl.includes('/react-js-jobs') && !currentUrl.includes('page=listing')) {
      console.log(`[Browser Info] Navigating main page back to jobs listing...`);
      await mainPage.goto(realUrl);
      await new Promise(r => setTimeout(r, 2000));
    }

    // Trigger Goal: mass apply
    console.log('Triggering mass apply pipeline...');
    await sidebarPage.evaluate(() => {
      const input = document.getElementById('goalInput');
      input.value = 'mass apply';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('runBtn').click();
    });

    // Poll and print chat logs
    let printedLogsCount = 0;
    let isDisconnected = false;
    browser.on('disconnected', () => {
      isDisconnected = true;
    });

    while (!isDisconnected) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const logs = await sidebarPage.evaluate(() => {
          const entries = document.querySelectorAll('#chatBox .message');
          return Array.from(entries).map(el => {
            const text = el.querySelector('.text')?.textContent || el.textContent;
            return text;
          });
        });

        if (logs.length > printedLogsCount) {
          for (let i = printedLogsCount; i < logs.length; i++) {
            console.log(`[Chat Log] ${logs[i]}`);
          }
          printedLogsCount = logs.length;
        }
      } catch (e) {
        // sidebarPage might be closed or navigating
      }
    }

    console.log('Browser closed. Exiting.');
    process.exit(0);

  } catch (err) {
    console.error('Error during auto-apply run:', err);
    process.exit(1);
  }
}

runRealApply();
