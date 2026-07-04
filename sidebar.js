// sidebar.js - Chat UI, command router, and the LLM step-agent loop
// Depends on (loaded first): js/config.js, js/storage.js, js/llm.js, js/actions.js

// ── DOM Bindings ────────────────────────────────────────────────────
const goalInput  = document.getElementById('goalInput');
const chatBox    = document.getElementById('chatBox');
const runBtn     = document.getElementById('runBtn');
const stopBtn    = document.getElementById('stopBtn');
const statusPill = document.getElementById('statusPill');
const statusText = document.getElementById('statusText');

let thinkingBubble = null;

// ── Startup ─────────────────────────────────────────────────────────
loadAgentState().then(() => {
  if (agentState.goal) {
    goalInput.value = agentState.goal;
    goalInput.dispatchEvent(new Event('input'));
  }
});

setStatus(false, 'Connecting...');
{
  const llm = JA.llmConfig();
  testConnection(llm.baseUrl, llm.apiKey).then(ok => {
    if (ok) {
      setStatus(true, 'Connected');
      logToChat('✓ Connected to FreeLLMAPI VM.', 'done');
    } else {
      setStatus(false, 'Offline');
      logToChat('⚠ Unable to reach FreeLLMAPI VM. Please check your VM status.', 'warn');
    }
  });
}

// Offer to resume an interrupted mass-apply session
if (JA.pipeline) {
  JA.pipeline.hasActiveSession().then(async (has) => {
    if (!has) return;
    const choice = await awaitUserChoice(
      'An interrupted mass-apply session was found. Resume it?',
      ['Resume', 'Discard']
    );
    if (choice === 'Resume') {
      if (!JA.flags.isRunning) await startRun(() => JA.pipeline.resume());
    } else if (choice === 'Discard') {
      await JA.store.clearSession();
      logToChat('Session discarded.', 'info');
    }
  });
}

// ── Textarea Auto-resize & Keybinds ─────────────────────────────────
goalInput.addEventListener('input', () => {
  goalInput.style.height = 'auto';
  goalInput.style.height = (goalInput.scrollHeight) + 'px';
});

goalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    runBtn.click();
  }
});

stopBtn.addEventListener('click', () => {
  JA.flags.shouldStop = true;
  resolvePendingChoices('Stop');
  logToChat('⛔ Stopping agent...', 'error');
});

// ── Main Run / Command Router ───────────────────────────────────────
runBtn.addEventListener('click', async () => {
  if (JA.flags.isRunning) return;
  const prompt = goalInput.value.trim();
  if (!prompt) return;

  // Log user message bubble
  logToChat(prompt, 'user');
  goalInput.value = '';
  goalInput.style.height = 'auto';

  const cmd = prompt.toLowerCase();

  if (/^history\b/.test(cmd)) {
    await showHistory();
    return;
  }
  if (/^resume\b/.test(cmd)) {
    if (JA.flags.isRunning) return;
    await startRun(() => JA.pipeline.resume());
    return;
  }
  if (/^(mass apply|apply all|\/apply)\b/.test(cmd)) {
    await startMassApply(/dry/.test(cmd) ? 'dry-run' : null);
    return;
  }

  // Anything else: the conversational step agent
  saveAgentState({ goal: prompt });
  await startRun(() => runAgentLoop({ goal: prompt }));
});

// Launches the mass-apply pipeline (also wired to the ▶ Mass Apply button).
// modeOverride forces a mode for this run; otherwise appSettings.mode is used.
async function startMassApply(modeOverride = null) {
  if (JA.flags.isRunning) return;
  if (!JA.pipeline) {
    logToChat('Mass apply pipeline is not available in this build.', 'warn');
    return;
  }
  const settings = await JA.store.getSettings();
  const mode = modeOverride || settings.mode;
  await startRun(() => JA.pipeline.start({ mode }));
}

async function showHistory() {
  const history = await JA.store.getHistory();
  if (!history.length) {
    logToChat('No applications recorded yet.', 'info');
    return;
  }
  const count = s => history.filter(r => r.status === s).length;
  logToChat(`History: ${count('applied')} applied | ${count('skipped')} skipped | ${count('failed')} failed — showing last ${Math.min(10, history.length)}`, 'done');
  history.slice(-10).forEach(rec => {
    const tone = rec.status === 'applied' ? 'done' : rec.status === 'failed' ? 'error' : 'warn';
    logToChat(`[${rec.status}] ${rec.title} @ ${rec.company}${rec.reason ? ' — ' + rec.reason : ''}`, tone);
  });
}

// Wraps a run with button toggling and flag management
async function startRun(fn) {
  JA.flags.isRunning  = true;
  JA.flags.shouldStop = false;

  runBtn.style.display = 'none';
  stopBtn.style.display = 'flex';

  try {
    await fn();
  } catch(e) {
    logToChat('Fatal: ' + e.message, 'error');
    console.error(e);
  } finally {
    JA.flags.isRunning = false;
    runBtn.style.display = 'flex';
    stopBtn.style.display = 'none';
    removeThinking();
  }
}

// ── LLM Step-Agent Loop ─────────────────────────────────────────────
// Runs the step-by-step LLM agent until DONE/error/step-limit/stop.
// Also used as a bounded fallback subroutine by the mass-apply pipeline.
async function runAgentLoop({ goal, maxSteps = JA.CONFIG.agentMaxSteps } = {}) {
  let currentTabId = null;
  let result = { status: 'done', lastUrl: '' };

  try {
    let history = [];
    let stepNum = 0;
    let stuckCount = 0; // failed verifications / missing context since last progress
    let lastActionSig = null;
    let repeatCount = 0; // consecutive identical actions

    while (stepNum < maxSteps && !JA.flags.shouldStop) {
      stepNum++;

      // Get the currently active tab
      let tab;
      try {
        const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
        tab = t;
      } catch(e) {}

      if (!tab) {
        logToChat('No active tab found.', 'error');
        result.status = 'error';
        break;
      }

      // Track active tab transitions (if user switches tabs or if a new tab is opened)
      if (tab.id !== currentTabId) {
        if (currentTabId) {
          try { await chrome.tabs.sendMessage(currentTabId, { type: 'STOP_AGENT' }); } catch(e) {}
        }
        currentTabId = tab.id;
        try { await chrome.tabs.sendMessage(currentTabId, { type: 'START_AGENT' }); } catch(e) {}
      }

      // Always run CAPTCHA handling first (never bypassed by overlay)
      const wasCaptcha = await handleCaptchaCheck(tab);
      if (wasCaptcha) {
        continue;
      }

      // Always run Navigation Filter first (never bypassed by overlay)
      const wasFiltered = await handleNavigationFilter(tab);
      if (wasFiltered) {
        continue;
      }

      // Run Overlay check
      const overlayPresent = await checkOverlayPresent(tab.id);
      if (overlayPresent) {
        logToChat('ℹ️ Active Overlay (Side Drawer/Modal/Form) detected. Bypassing other filters.', 'done');
      }

      // 1. Get DOM context from the page
      let context = null;
      try {
        context = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTEXT' });
      } catch(e) {
        console.error('GET_CONTEXT failed:', e.message || e);
      }

      let contextText = '';
      if (context) {
        let statsStr = '';
        if (context.stats) {
          const s = context.stats;
          statsStr = ` (Total: ${s.totalFound}, display:none: ${s.displayNone}, hidden: ${s.visibilityHidden}, disabled: ${s.disabled}, zero-size: ${s.zeroSize})`;
        }
        logToChat(`Extracted page state (${context.elementsCount || 0} interactive items discovered)${statsStr}.`, 'shot');
        contextText = `Active Tab URL: ${context.url}\nActive Tab Title: ${context.title}\n\nInteractive elements on page:\n${context.elements || '(none)'}\n\nPage Main Text Content Snippet:\n${context.bodyText || '(none)'}`;
        if (context.overlayInfo) {
          contextText += `\n${context.overlayInfo}`;
        }
        if (repeatCount >= 1 && lastActionSig) {
          contextText += `\n\n⚠ CRITICAL: You have tried the SAME action (${lastActionSig}) ${repeatCount + 1} times and it did NOT achieve the goal. Do NOT choose it again — pick a DIFFERENT action or target, or DONE if the goal is impossible here.`;
        }
      } else {
        logToChat('No page details could be extracted. Ensure the tab is fully loaded and not a chrome:// system page.', 'warn');
        contextText = `(No page context could be retrieved. The user might be on a chrome:// tab or the page is still loading.)`;
        stuckCount++;
      }

      // Automatically update persistent state and tracking last real page/URL
      const currentURL = (context && context.url) ? context.url : (tab.url || 'Unknown');
      result.lastUrl = currentURL;
      const historyList = agentState.navigationHistory || [];
      if (currentURL !== 'Unknown' && historyList[historyList.length - 1] !== currentURL) {
        historyList.push(currentURL);
        if (historyList.length > 10) historyList.shift();
      }

      const trackingKeywords = [
        'doubleclick',
        'googlesyndication',
        'googleads',
        'adservice',
        'googleadservices',
        'recaptcha',
        'traffic',
        'analytics',
        'pixel',
        'adclick',
        'about:blank',
        'chrome-error://',
        'chrome-extension://'
      ];
      const isTracking = trackingKeywords.some(kw => currentURL.toLowerCase().includes(kw));

      // Auto success/applied job tracking
      if (currentURL.includes('page=success') || currentURL.includes('success')) {
        const jobTitle = agentState.currentJob || 'Unknown';
        if (jobTitle !== 'Unknown' && !agentState.appliedJobs.includes(jobTitle)) {
          const newApplied = [...agentState.appliedJobs, jobTitle];
          const newProcessed = [...agentState.processedJobs];
          if (!newProcessed.includes(jobTitle)) newProcessed.push(jobTitle);
          saveAgentState({
            appliedJobs: newApplied,
            processedJobs: newProcessed
          });
          logToChat(`💾 Auto-saved Job "${jobTitle}" as APPLIED in memory.`, 'done');
        }
      }

      // Auto processed/visited job tracking
      if (currentURL.includes('page=detail') || currentURL.includes('job/')) {
        const jobTitle = agentState.currentJob || 'Unknown';
        if (jobTitle !== 'Unknown' && !agentState.processedJobs.includes(jobTitle)) {
          const newProcessed = [...agentState.processedJobs, jobTitle];
          saveAgentState({ processedJobs: newProcessed });
          logToChat(`💾 Auto-saved Job "${jobTitle}" as VISITED in memory.`, 'step');
        }
      }

      if (!isTracking && currentURL !== 'Unknown') {
        saveAgentState({
          lastURL: currentURL,
          navigationHistory: historyList,
          lastRealURL: currentURL,
          lastRealPage: agentState.currentPage || 'Unknown'
        });
      } else {
        saveAgentState({
          lastURL: currentURL,
          navigationHistory: historyList
        });
      }

      if (isTracking) {
        logToChat(`↩ Stuck on tracking/redirect page: ${currentURL}. Attempting recovery...`, 'warn');
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => window.history.back()
          });
        } catch(e) {}
        await sleep(2000);

        // Re-check tab
        try {
          const finalTab = await chrome.tabs.get(tab.id);
          const finalUrl = finalTab.url || finalTab.pendingUrl || "";
          const stillTracking = trackingKeywords.some(kw => finalUrl.toLowerCase().includes(kw));
          if (stillTracking) {
            const lastReal = agentState.lastRealURL;
            if (lastReal && (lastReal.startsWith('http://') || lastReal.startsWith('https://'))) {
              logToChat(`↩ Still stuck on tracking page. Direct navigating back to last real page: ${lastReal}`, 'warn');
              await chrome.tabs.update(tab.id, { url: lastReal });
              await sleep(2000);
            }
          }
        } catch(e) {}
        continue;
      }

      // 2. Ask AI — attach screenshot(s) when stuck or when the DOM
      // extraction looks too sparse to be trusted
      let screenshots = null;
      const sparseDom = context && (context.elementsCount || 0) < (JA.CONFIG.visionSparseDomThreshold || 0);
      if (JA.CONFIG.visionOnStuck && (stuckCount >= 1 || sparseDom || !context)) {
        const shot = await captureTabScreenshot(tab);
        if (shot) {
          screenshots = [shot];
          logScreenshotToChat(shot, stuckCount >= 1
            ? `Stuck signal ${stuckCount} — looking at the actual screen.`
            : 'DOM extraction looks incomplete — looking at the actual screen.');
          if (stuckCount >= 2 && JA.CONFIG.visionZoomWhenStillStuck) {
            try {
              const zoomed = await zoomScreenshot(shot, { hFrac: 0.5, scale: 2 });
              screenshots.push(zoomed);
              logScreenshotToChat(zoomed, 'Still stuck — also attaching a 2× zoom of the top half.');
            } catch (e) {}
          }
        }
      }

      showThinking();
      let resObj;
      try {
        const llm = JA.llmConfig();
        resObj = await askFreeLLM(llm.baseUrl, llm.apiKey, llm.model, goal, contextText, history, stepNum, screenshots);
      } catch(e) {
        removeThinking();
        logToChat('Error contacting AI: ' + e.message, 'error');
        result.status = 'error';
        break;
      }
      removeThinking();

      // Display AI conversational response
      if (resObj.response) {
        logToChat(resObj.response, 'ai');
      }

      // Save updated state if returned by the AI
      if (resObj.state) {
        saveAgentState(resObj.state);
        logToChat(`💾 State updated (currentPage: ${resObj.state.currentPage || 'N/A'}, applied: ${agentState.appliedJobs?.length || 0})`, 'step');
      }

      // Record job as applied if the AI agent successfully navigated to a Success page state
      const isSuccessState = resObj.state && (resObj.state.currentPage === 'Success' || resObj.state.currentPage === 'Success Page');
      if (isSuccessState) {
        const jobTitle = agentState.currentJob || 'Unknown';
        if (jobTitle !== 'Unknown' && !agentState.appliedJobs.includes(jobTitle)) {
          const newApplied = [...agentState.appliedJobs, jobTitle];
          const newProcessed = [...agentState.processedJobs];
          if (!newProcessed.includes(jobTitle)) newProcessed.push(jobTitle);
          saveAgentState({
            appliedJobs: newApplied,
            processedJobs: newProcessed
          });
          logToChat(`💾 Auto-saved Job "${jobTitle}" as APPLIED in memory (AI detected Success).`, 'done');
        }
      }

      // Auto-extract job title from clicked elements to update currentJob state
      if (resObj.action && (agentState.currentPage === 'Listing' || currentURL.includes('page=listing'))) {
        const action = resObj.action;
        if (action.type === 'click_text') {
          const ignoreKeywords = ['apply', 'back', 'listings', 'search', 'next', 'prev', 'submit', 'done'];
          const isJobTitle = !ignoreKeywords.some(kw => action.text.toLowerCase().includes(kw));
          if (isJobTitle) {
            saveAgentState({ currentJob: action.text });
            logToChat(`💾 Mapping currentJob to: "${action.text}"`, 'step');
          }
        } else if (action.type === 'click' && action.selector) {
          const match = action.selector.match(/agent-(\d+)/);
          if (match && context && context.elements) {
            const agentId = `agent-${match[1]}`;
            const lines = context.elements.split('\n');
            const line = lines.find(l => l.includes(`[${agentId}]`));
            if (line) {
              const labelMatch = line.match(/labeled "(.*?)"/);
              if (labelMatch) {
                saveAgentState({ currentJob: labelMatch[1] });
                logToChat(`💾 Mapping currentJob to: "${labelMatch[1]}"`, 'step');
              }
            }
          }
        }
      }

      // 3. Evaluate action
      if (!resObj.action) {
        // Chat concluded or answered without action
        break;
      }

      const action = resObj.action;

      // Handle done/error actions inside the object
      if (action.type === 'done') {
        logToChat(`✓ Done: ${action.message || 'Task complete'}`, 'done');
        break;
      }
      if (action.type === 'error') {
        logToChat(`✕ Failed: ${action.message || 'Action error'}`, 'error');
        result.status = 'error';
        break;
      }

      // Loop detection: the same action repeated is not progress, no matter
      // what verification says — treat as stuck (triggers vision analysis).
      const actionSig = `${action.type}:${action.text || action.selector || action.url || action.key || ''}`;
      if (actionSig === lastActionSig) {
        repeatCount++;
        stuckCount++;
        logToChat(`⚠ Repeating the same action (${repeatCount + 1}×) — flagging as stuck.`, 'warn');
      } else {
        repeatCount = 0;
      }
      lastActionSig = actionSig;

      // Log status step
      logToChat(`Running Step ${stepNum}...`, 'step');

      // 4. Execute Action
      let targetStr = '';
      if (action.selector) targetStr = ` on "${action.selector}"`;
      else if (action.text) targetStr = ` on "${action.text}"`;
      else if (action.url) targetStr = ` to "${action.url}"`;
      else if (action.key) targetStr = ` key "${action.key}"`;

      logToChat(`⚡ Executing ${action.type}${targetStr}`, 'action');

      const previousDOMSize = context ? context.elementsCount : 0;
      try {
        await executeAction(tab, action);
        await adaptiveWait(action.type);
      } catch(e) {
        logToChat(`Action execution failed: ${e.message}`, 'error');
        stuckCount++;
      }

      // Verification check after action execution
      await sleep(1500);
      let verifyURL = 'Unknown';
      let verifyDOMSize = 0;
      try {
        const verifyTab = await chrome.tabs.get(tab.id);
        verifyURL = verifyTab.url || 'Unknown';
        const verifyContext = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTEXT' });
        verifyDOMSize = verifyContext ? verifyContext.elementsCount : 0;
      } catch(e) {}

      if (['click', 'click_text', 'navigate'].includes(action.type)) {
        const urlChanged = verifyURL !== currentURL;
        const domChanged = verifyDOMSize !== previousDOMSize;
        if (!urlChanged && !domChanged && !overlayPresent) {
          logToChat(`⚠ Verification: Page did not change.`, 'warn');
          stuckCount++;
        } else {
          logToChat(`✓ Verification: Page state changed.`, 'done');
          stuckCount = 0;
        }
      }

      history.push({
        step: stepNum,
        type: action.type,
        target: action.text || action.selector || action.url || action.key || '',
        action: action
      });
    }

    if (JA.flags.shouldStop) result.status = 'stopped';
    if (stepNum >= maxSteps) {
      logToChat(`Reached maximum step limit (${maxSteps}).`, 'error');
      result.status = 'maxSteps';
    }

  } finally {
    removeThinking();
    // Hide control border on the last active tab
    if (currentTabId) {
      try { await chrome.tabs.sendMessage(currentTabId, { type: 'STOP_AGENT' }); } catch(e) {}
    }
  }

  return result;
}

// ── UI Helpers ──────────────────────────────────────────────────────
function logToChat(message, type = 'info') {
  const msgEl = document.createElement('div');

  if (type === 'user') {
    msgEl.className = 'message user';
    msgEl.innerHTML = `<span class="text">${escHtml(message)}</span>`;
  } else if (type === 'ai') {
    msgEl.className = 'message ai';
    msgEl.innerHTML = `<div style="font-size: 10px; color: var(--muted); margin-bottom: 4px;">Assistant</div><span class="text">${escHtml(message)}</span>`;
  } else {
    msgEl.className = `message status ${type}`;
    let icon = '·';
    if (type === 'action') icon = '⚡';
    if (type === 'shot')   icon = '🔍';
    if (type === 'error')  icon = '✕';
    if (type === 'warn')   icon = '⚠';
    if (type === 'step')   icon = '▸';
    if (type === 'done')   icon = '✓';

    msgEl.innerHTML = `<span class="icon">${icon}</span><span class="text">${escHtml(message)}</span>`;
  }

  chatBox.appendChild(msgEl);
  chatBox.scrollTop = chatBox.scrollHeight;
  return msgEl;
}

// Show a screenshot in the chat as a small thumbnail (click to open full-size)
function logScreenshotToChat(dataUrl, caption) {
  const msgEl = document.createElement('div');
  msgEl.className = 'message status shot';
  msgEl.innerHTML = `<span class="icon">📸</span><span class="text">${escHtml(caption || 'Screenshot')}</span>`;
  const img = document.createElement('img');
  img.src = dataUrl;
  img.style.cssText = 'display:block;max-width:100px;max-height:100px;margin:6px 0 0 24px;' +
                      'border:1px solid var(--muted,#888);border-radius:6px;cursor:zoom-in;';
  img.title = 'Click to open full size';
  img.addEventListener('click', async () => {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      chrome.tabs.create({ url: URL.createObjectURL(blob) });
    } catch (e) {}
  });
  msgEl.appendChild(img);
  chatBox.appendChild(msgEl);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// Crop a region of a screenshot and scale it up (default: top half at 2×),
// so small buttons/labels become readable for the vision model.
async function zoomScreenshot(dataUrl, { xFrac = 0, yFrac = 0, wFrac = 1, hFrac = 0.5, scale = 2 } = {}) {
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('screenshot decode failed'));
    i.src = dataUrl;
  });
  const sx = img.width * xFrac, sy = img.height * yFrac;
  const sw = img.width * wFrac, sh = img.height * hFrac;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.7);
}

function showThinking() {
  removeThinking();
  thinkingBubble = document.createElement('div');
  thinkingBubble.className = 'message ai thinking';
  thinkingBubble.innerHTML = `<div style="font-size: 10px; color: var(--muted); margin-bottom: 4px;">Assistant</div><div class="dots"><span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></div>`;
  chatBox.appendChild(thinkingBubble);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function removeThinking() {
  if (thinkingBubble && thinkingBubble.parentNode) {
    thinkingBubble.parentNode.removeChild(thinkingBubble);
  }
  thinkingBubble = null;
}

function setStatus(ready, text) {
  statusPill.className = 'status-pill' + (ready ? ' ready' : '');
  statusText.textContent = text || (ready ? 'Ready' : 'Offline');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Inline chat choices ─────────────────────────────────────────────
// Renders a chat message with buttons and resolves with the clicked label.
// The Stop button resolves all pending choices with 'Stop'.
let pendingChoiceResolvers = [];

function awaitUserChoice(message, options, type = 'step') {
  return new Promise(resolve => {
    const msgEl = logToChat(message, type);
    const wrap = document.createElement('div');
    wrap.className = 'chat-buttons';

    const finish = (label, chosenBtn) => {
      pendingChoiceResolvers = pendingChoiceResolvers.filter(r => r !== finish);
      wrap.querySelectorAll('button').forEach(b => b.disabled = true);
      if (chosenBtn) chosenBtn.classList.add('chosen');
      resolve(label);
    };
    pendingChoiceResolvers.push(finish);

    options.forEach(label => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.addEventListener('click', () => finish(label, btn));
      wrap.appendChild(btn);
    });

    msgEl.appendChild(wrap);
    chatBox.scrollTop = chatBox.scrollHeight;
  });
}

function resolvePendingChoices(label) {
  [...pendingChoiceResolvers].forEach(finish => finish(label, null));
}
