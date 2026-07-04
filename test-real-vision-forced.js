// test-real-vision-forced.js - Force the stuck path on the REAL Naukri site:
// the goal targets a button that does not exist, so clicks fail and the
// vision pipeline (screenshot -> zoom -> chat thumbnails) must engage.
// puppeteer is ESM-only (v22+): loaded via dynamic import at the launch site
const path = require('path');

const REAL_URL = 'https://www.naukri.com/react-js-jobs?k=react%20js';
const HARD_TIMEOUT_MS = 6 * 60 * 1000;

async function run() {
  const extensionPath = path.resolve(__dirname);
  const userDataDir = path.resolve(__dirname, '.chrome-profile');

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
    for (let i = 0; i < 20 && !sw; i++) {
      sw = (await browser.targets()).find(t => t.type() === 'service_worker');
      if (!sw) await new Promise(r => setTimeout(r, 1000));
    }
    if (!sw) return exit(1, '✕ Extension service worker never appeared.');
    const extId = sw.url().split('/')[2];

    const sidebarPage = await browser.newPage();
    await sidebarPage.goto(`chrome-extension://${extId}/sidebar.html`);
    const blank = (await browser.pages()).find(p => p.url() === 'about:blank');
    if (blank) await blank.close();
    await sidebarPage.evaluate(() => new Promise(res =>
      chrome.storage.local.set({ agentState: null }, res)));

    const mainPage = await browser.newPage();
    await mainPage.goto(REAL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await mainPage.bringToFront();
    await new Promise(r => setTimeout(r, 4000));

    console.log('Sending impossible-click goal to force the stuck/vision path...');
    await sidebarPage.evaluate(() => {
      const input = document.getElementById('goalInput');
      input.value = 'Click the button labeled "Download Brochure" on this page. Only use CLICK("Download Brochure"). If after looking at a screenshot you are sure it does not exist, DONE.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('runBtn').click();
    });

    const startedAt = Date.now();
    let printed = 0;
    let maxThumbs = 0;
    while (Date.now() - startedAt < HARD_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, 2000));
      let state = null;
      try {
        state = await sidebarPage.evaluate(() => ({
          logs: Array.from(document.querySelectorAll('#chatBox .message'))
            .map(el => el.querySelector('.text')?.textContent || el.textContent),
          thumbs: document.querySelectorAll('#chatBox img').length,
          running: document.getElementById('stopBtn')?.style.display !== 'none'
        }));
      } catch (e) { continue; }

      for (; printed < state.logs.length; printed++) console.log(`[Chat] ${state.logs[printed]}`);
      if (state.thumbs > maxThumbs) {
        console.log(`>>> VISION: ${state.thumbs} screenshot thumbnail(s) now in chat.`);
        maxThumbs = state.thumbs;
      }

      const all = state.logs.join('\n');
      if (/✓ Done|maximum step limit|Error contacting AI/i.test(all) || !state.running) {
        await new Promise(r => setTimeout(r, 1500));
        await sidebarPage.bringToFront();
        await sidebarPage.screenshot({ path: path.join(__dirname, 'vision-forced-sidebar.png') }).catch(() => {});
        const verdict = maxThumbs > 0 ? 0 : 4;
        return exit(verdict, `\n${maxThumbs > 0 ? '✓' : '✕'} RUN ENDED — ${maxThumbs} thumbnail(s) shown. Screenshot: vision-forced-sidebar.png`);
      }
    }
    return exit(3, '\n✕ Hard timeout.');
  } catch (err) {
    console.error('Error:', err);
    return exit(1);
  }
}

run();
