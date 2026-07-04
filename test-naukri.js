// puppeteer is ESM-only (v22+): loaded via dynamic import at the launch site
const path = require('path');
const http = require('http');
const fs = require('fs');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTest() {
  const extensionPath = path.resolve(__dirname);
  console.log('Extension path:', extensionPath);

  // Start a local HTTP server to serve naukri-mock.html
  console.log('Starting local HTTP server...');
  const server = http.createServer((req, res) => {
    try {
      const filePath = path.resolve(__dirname, 'naukri-mock.html');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(filePath));
    } catch (e) {
      res.writeHead(500);
      res.end('Error reading naukri-mock.html');
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`Local HTTP server running at http://localhost:${port}/naukri-mock.html`);

  console.log('Launching browser...');
  const browser = await (await import('puppeteer')).default.launch({
    headless: false, // Extension testing requires headful mode
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  });

  let testPassed = false;

  try {
    // 1. Find the extension service worker to get the extension ID
    console.log('Waiting for extension to load...');
    await sleep(2000);
    const targets = await browser.targets();
    const serviceWorkerTarget = targets.find(t => t.type() === 'service_worker');
    
    if (!serviceWorkerTarget) {
      throw new Error('Could not find extension service worker. Make sure manifest.json is correct.');
    }

    const serviceWorkerUrl = serviceWorkerTarget.url();
    const extensionId = serviceWorkerUrl.split('/')[2];
    console.log(`Extension loaded successfully. ID: ${extensionId}`);

    // 2. Open the sidebar page in tab 1
    console.log('Opening extension sidebar...');
    const sidebarPage = await browser.newPage();

    // Capture logs from sidebar
    sidebarPage.on('console', msg => {
      console.log(`[Sidebar Console] [${msg.type()}] ${msg.text()}`);
    });
    sidebarPage.on('pageerror', err => {
      console.error(`[Sidebar PageError] ${err.stack}`);
    });

    await sidebarPage.goto(`chrome-extension://${extensionId}/sidebar.html`);
    
    // Close the initial blank tab if there is one
    const pages = await browser.pages();
    const blankPage = pages.find(p => p.url() === 'about:blank');
    if (blankPage) await blankPage.close();

    // 3. Open the mock Naukri listings page in tab 2
    console.log('Opening mock Naukri listing page...');
    const mainPage = await browser.newPage();

    mainPage.on('console', msg => {
      console.log(`[Main Console] [${msg.type()}] ${msg.text()}`);
    });
    mainPage.on('pageerror', err => {
      console.error(`[Main PageError] ${err.stack}`);
    });

    const testUrl = `http://localhost:${port}/naukri-mock.html?page=listing`;
    await mainPage.goto(testUrl);
    await mainPage.bringToFront();

    // 4. Check sidebar status
    console.log('Checking sidebar connection to backend...');
    await sidebarPage.bringToFront();
    
    let isConnected = false;
    for (let i = 0; i < 10; i++) {
      const statusText = await sidebarPage.$eval('#statusText', el => el.textContent);
      console.log(`Sidebar status: ${statusText}`);
      if (statusText === 'Connected') {
        isConnected = true;
        break;
      }
      await sleep(1000);
    }

    if (!isConnected) {
      console.warn('Backend connection is not ready, but we will attempt to proceed.');
    }

    // Monitor chat log box in sidebar
    const printChatLogs = async () => {
      const logs = await sidebarPage.evaluate(() => {
        const entries = document.querySelectorAll('#chatBox .message');
        return Array.from(entries).map(el => {
          const type = el.className;
          const text = el.querySelector('.text')?.textContent || el.textContent;
          return `[Chat Log - ${type}] ${text}`;
        });
      });
      return logs;
    };

    // Trigger Goal: Apply to every eligible job on the listings page
    console.log('--- Triggering Agent Run ---');
    await sidebarPage.evaluate(() => {
      const input = document.getElementById('goalInput');
      input.value = 'Apply to every eligible job on this listing.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    console.log('Ensuring main page is active...');
    await mainPage.bringToFront();
    await sleep(1000);

    console.log('Clicking run button to initiate Naukri mock application flow...');
    await sidebarPage.evaluate(() => {
      document.getElementById('runBtn').click();
    });

    // Monitor the flow for up to 240 seconds (each agent step takes ~8-10s
    // of fixed waits + LLM latency; two full applications need ~150-200s)
    const startTime = Date.now();
    let lastUrl = '';
    const successList = new Set();

    while (Date.now() - startTime < 240000) {
      let currentUrl = '';
      try {
        currentUrl = await mainPage.evaluate(() => window.location.href);
      } catch (e) {
        await sleep(1000);
        continue;
      }

      // Check if we reached success page (extract jobId from the lastUrl where query parameters existed)
      const isSuccess = currentUrl.includes('page=success');
      if (isSuccess) {
        const jobMatch = currentUrl.match(/id=(\d+)/) || lastUrl.match(/id=(\d+)/);
        const jobId = jobMatch ? jobMatch[1] : 'unknown';
        if (jobId !== 'unknown' && !successList.has(jobId)) {
          successList.add(jobId);
          console.log(`✓ Confirmed success page reached for Job ID: ${jobId}!`);
        }
      }

      if (currentUrl !== lastUrl) {
        console.log(`\n[Browser Navigation] Tab transitioned to: ${currentUrl}`);
        lastUrl = currentUrl;
      }

      // Check if we applied to all 2 jobs on our mock portal
      if (successList.size >= 2) {
        console.log('\n--- SUCCESS! All jobs in mock portal successfully applied to by the agent! ---');
        testPassed = true;
        break;
      }

      // Output latest logs from the agent chat
      const currentLogs = await printChatLogs();
      if (currentLogs.length > 0) {
        console.log(`[Agent Step Log] ${currentLogs[currentLogs.length - 1]}`);
      }

      await sleep(2000);
    }

    if (!testPassed) {
      throw new Error(`Test failed: only applied to ${successList.size} out of 2 jobs.`);
    }

  } catch (err) {
    console.error('Error during test execution:', err);
    process.exitCode = 1;
  } finally {
    console.log('Closing browser and stopping server...');
    try {
      if (server) {
        server.close();
      }
      await browser.close();
    } catch (e) {
      console.error('Error during cleanup:', e);
    }
    console.log('Done.');
    process.exit(process.exitCode || 0);
  }
}

runTest();
