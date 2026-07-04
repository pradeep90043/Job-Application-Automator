// test-real.js - Puppeteer launcher to run the extension on the real Naukri site.
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
  mode: 'dry_run', // Default to dry_run mode for safety
  matchThreshold: 70,
  applyDelayMs: 3000,
  maxApplicationsPerSession: 5,
  perJobTimeoutMs: 90000,
  confirmBeforeAuto: true,
  llm: {}
};

async function runRealTest() {
  const extensionPath = path.resolve(__dirname);
  console.log('Extension path:', extensionPath);
  console.log('Launching headful Chrome...');

  try {
    const browser = await (await import('puppeteer')).default.launch({
      headless: false,
      defaultViewport: null, // Allow maximize
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ]
    });

    console.log('Waiting for extension to load...');
    await new Promise(r => setTimeout(r, 2000));
    
    const sw = (await browser.targets()).find(t => t.type() === 'service_worker');
    if (!sw) {
      throw new Error('Could not find extension service worker.');
    }
    const extId = sw.url().split('/')[2];
    console.log(`Extension loaded successfully. ID: ${extId}`);

    // Open sidebar page
    console.log('Opening extension sidebar...');
    const sidebarPage = await browser.newPage();
    await sidebarPage.goto(`chrome-extension://${extId}/sidebar.html`);

    // Close the initial blank tab if there is one
    const pages = await browser.pages();
    const blankPage = pages.find(p => p.url() === 'about:blank');
    if (blankPage) await blankPage.close();

    // Seed mock profile/settings if storage is empty
    await sidebarPage.evaluate((profile, settings) => new Promise(res => {
      chrome.storage.local.get(['userProfile'], (data) => {
        if (!data.userProfile) {
          chrome.storage.local.set({
            userProfile: profile,
            appSettings: settings,
            applicationHistory: [],
            agentState: null
          }, res);
        } else {
          res();
        }
      });
    }), SEED_PROFILE, SEED_SETTINGS);

    // Open real Naukri page
    console.log('Opening real Naukri React jobs listing page...');
    const mainPage = await browser.newPage();
    const realUrl = 'https://www.naukri.com/react-js-jobs?k=react%20js&nignbevent_src=jobsearchDeskGNB';
    await mainPage.goto(realUrl);
    await mainPage.bringToFront();

    console.log('\n================================================================');
    console.log('Chrome is open with the real Naukri listing and the extension.');
    console.log('You can now see the extension sidebar in the first tab.');
    console.log('Feel free to solve CAPTCHAs, log in, or run/test the agent.');
    console.log('================================================================\n');

    // Keep script running until the browser window is closed
    await new Promise(resolve => browser.on('disconnected', resolve));
    console.log('Browser closed. Exiting.');
    process.exit(0);

  } catch (err) {
    console.error('Error launching browser:', err);
    process.exit(1);
  }
}

runRealTest();
