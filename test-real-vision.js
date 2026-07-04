// test-real-vision.js - Drive the AI agent on a REAL Naukri job that
// previously FAILED (chatbot questionnaire), and observe the new vision
// (screenshot / zoom / thumbnail) behavior when the agent gets stuck.
// puppeteer is ESM-only (v22+): loaded via dynamic import at the launch site
const path = require('path');

const HARD_TIMEOUT_MS = 8 * 60 * 1000;

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
    console.log(`Extension ID: ${extId}`);

    const sidebarPage = await browser.newPage();
    await sidebarPage.goto(`chrome-extension://${extId}/sidebar.html`);
    const blank = (await browser.pages()).find(p => p.url() === 'about:blank');
    if (blank) await blank.close();

    // Pick a previously FAILED job with a URL from application history.
    // Optional argv[2] filters by title substring (case-insensitive).
    const titleFilter = (process.argv[2] || '').toLowerCase();
    const target = await sidebarPage.evaluate((filter) => new Promise(res => {
      chrome.storage.local.get(['applicationHistory'], (data) => {
        const hist = data.applicationHistory || [];
        let failed = hist.filter(r => r.status === 'failed' && /^https?:\/\//.test(r.url || ''));
        if (filter) failed = failed.filter(r => (r.title || '').toLowerCase().includes(filter));
        res(failed.length ? failed[failed.length - 1] : null);
      });
    }), titleFilter);
    if (!target) return exit(2, '✕ No failed job with a URL found in history.');
    console.log(`Target job (previously failed): ${target.title} @ ${target.company}`);
    console.log(`URL: ${target.url}`);

    // Reset agent state so the loop starts fresh
    await sidebarPage.evaluate(() => new Promise(res =>
      chrome.storage.local.set({ agentState: null }, res)));

    const mainPage = await browser.newPage();
    await mainPage.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await mainPage.bringToFront();
    await new Promise(r => setTimeout(r, 4000));

    console.log('Sending agent goal: apply to this job...');
    await sidebarPage.evaluate(() => {
      const input = document.getElementById('goalInput');
      input.value = 'Apply to this job. If a questionnaire drawer opens, answer every question using my profile facts and submit each step.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('runBtn').click();
    });

    const startedAt = Date.now();
    let printed = 0;
    let visionEvents = 0;
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
      if (state.thumbs > visionEvents) {
        console.log(`>>> VISION: ${state.thumbs} screenshot thumbnail(s) now visible in chat.`);
        visionEvents = state.thumbs;
      }

      const all = state.logs.join('\n');
      const finished = /✓ Done|maximum step limit|Error contacting AI/i.test(all) || !state.running;
      if (finished) {
        await new Promise(r => setTimeout(r, 2000));
        await sidebarPage.bringToFront();
        await sidebarPage.screenshot({ path: path.join(__dirname, 'vision-real-sidebar.png') }).catch(() => {});
        await mainPage.bringToFront();
        await mainPage.screenshot({ path: path.join(__dirname, 'vision-real-page.png') }).catch(() => {});
        return exit(0, `\n✓ AGENT RUN ENDED — ${visionEvents} screenshot thumbnail(s) shown. Screenshots: vision-real-sidebar.png, vision-real-page.png`);
      }
    }
    await sidebarPage.screenshot({ path: path.join(__dirname, 'vision-real-sidebar.png') }).catch(() => {});
    return exit(3, '\n✕ Hard timeout reached.');
  } catch (err) {
    console.error('Error:', err);
    return exit(1);
  }
}

run();
