// pipeline.js - Mass-apply state machine:
// SCRAPE_LISTING → SCORE_JOBS → (per job) OPEN_JOB → APPLY_START → FILL_FORM
// → VERIFY_SUCCESS → RECORD → DELAY → ... → SUMMARY

JA.pipeline = (function () {

  function detectHandler(url) {
    for (const handler of Object.values(JA.sites)) {
      if (handler.matches(url)) return handler;
    }
    return null;
  }

  async function getActiveTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab || null;
    } catch (e) {
      return null;
    }
  }

  // Score a job: skip-list short-circuit → apply-list short-circuit → LLM.
  // LLM failure means skip — never auto-apply on uncertainty.
  async function evaluateJob(job, profile) {
    const text = `${job.title} ${(job.skills || []).join(' ')} ${job.description || ''}`.toLowerCase();
    for (const kw of (profile.skipList || [])) {
      if (kw && text.includes(kw.toLowerCase())) {
        return { match: false, score: 0, reason: `skip list: ${kw}` };
      }
    }
    for (const kw of (profile.applyList || [])) {
      if (kw && text.includes(kw.toLowerCase())) {
        return { match: true, score: 100, reason: `apply list: ${kw}` };
      }
    }
    try {
      return await scoreJob(job, profile);
    } catch (e) {
      return { match: false, score: 0, reason: `LLM scoring failed (${e.message})` };
    }
  }

  async function record(job, status, reason) {
    await JA.store.addHistoryRecord({
      jobKey: JA.store.jobKey(job),
      jobId: job.jobId || null,
      title: job.title,
      company: job.company,
      source: job.source,
      url: job.url || '',
      status,
      reason: reason || '',
      matchScore: job.score ?? null
    });
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(res => setTimeout(() => res({ status: 'timeout' }), ms))
    ]);
  }

  function profileFacts(profile) {
    const skills = Object.entries(profile.skills || {}).map(([k, v]) => `${k} ${v}yr`).join(', ');
    return `skills: ${skills}; notice period: ${profile.noticePeriod || 'n/a'}; ` +
           `current CTC: ${profile.currentCTC || 'n/a'}; expected CTC: ${profile.expectedCTC || 'n/a'}; ` +
           `relocation: ${profile.relocation ? 'yes' : 'no'}`;
  }

  async function backToListing(tab, listingUrl) {
    try {
      const t = await chrome.tabs.get(tab.id);
      if (t.url !== listingUrl) {
        await chrome.tabs.update(tab.id, { url: listingUrl });
        await waitUntilTabComplete(tab.id);
        await sleep(800);
      }
    } catch (e) {}
  }

  // ── Per-job apply flow ────────────────────────────────────────────
  async function applyToJob(tab, handler, job, profile, settings) {
    const fallbackUsed = { open: false, apply: false, form: false };

    // Re-locate the job card: data-mass-apply-id stamps don't survive navigation
    const fresh = await handler.scrapeJobs(tab.id);
    const key = JA.store.jobKey(job);
    const found = fresh.find(j => JA.store.jobKey(j) === key);
    if (!found) return { status: 'failed', reason: 'Job card not found on listing page' };
    job.massId = found.massId;

    // OPEN_JOB
    const opened = await handler.openJob(tab, job);
    if (!opened.ok && !fallbackUsed.open) {
      fallbackUsed.open = true;
      logToChat(`↪ Detail page not detected — escalating to AI agent.`, 'warn');
      await runAgentLoop({
        goal: `Open the job titled "${job.title}" and reach its details page where an Apply button is visible. Then DONE.`,
        maxSteps: JA.CONFIG.fallbackMaxSteps
      });
    }

    // Deferred scoring (LinkedIn: description only loads on the detail pane)
    if (handler.needsDetailForScoring && job.score == null) {
      if (handler.getDetailDescription) {
        job.description = await handler.getDetailDescription(tab) || job.description;
      }
      const v = await evaluateJob(job, profile);
      job.score = v.score; job.match = v.match; job.matchReason = v.reason;
      logToChat(`[${v.score}] ${job.title} @ ${job.company} — ${v.reason}`, v.match ? 'done' : 'warn');
      if (!(v.match && v.score >= settings.matchThreshold)) {
        return { status: 'skipped', reason: v.reason };
      }
    }

    // APPLY_START — retry once before escalating (slow detail pages), and
    // bail out cleanly if the job was already applied to earlier.
    let started = await handler.startApply(tab);
    if (!started.ok && !started.external) {
      if (await handler.detectSuccess(tab)) {
        return { status: 'skipped', reason: 'Already applied (detected on detail page)' };
      }
      await sleep(2000);
      started = await handler.startApply(tab);
    }
    if (started.external) {
      return { status: 'skipped', reason: 'External ATS (apply on company site)' };
    }
    if (!started.ok && !fallbackUsed.apply) {
      fallbackUsed.apply = true;
      logToChat(`↪ Apply button not found — escalating to AI agent.`, 'warn');
      await runAgentLoop({
        goal: `Find and click the "Apply" / "Apply Now" / "Easy Apply" button for the job "${job.title}". Then DONE.`,
        maxSteps: JA.CONFIG.fallbackMaxSteps
      });
    }

    // FILL_FORM — up to 10 steps; escalate once on unresolvable steps
    let lastHash = null, sameCount = 0;
    for (let s = 0; s < 10 && !JA.flags.shouldStop; s++) {
      const r = await fillFormStep(tab, job, profile);

      if (r.status === 'stopped_before_submit') {
        // Deliberately no cleanup: leave the form open for inspection
        return { status: 'failed', reason: 'Stopped before final submit (stopBeforeSubmit debug flag)' };
      }
      if (r.status === 'success' || r.status === 'no_overlay') break;

      if (r.status === 'unresolved' || r.status === 'no_advance') {
        // The apply may already have gone through (Naukri one-click applies
        // with no questions) — don't send the agent into a finished flow.
        if (await handler.detectSuccess(tab)) break;
        if (!fallbackUsed.form) {
          fallbackUsed.form = true;
          logToChat(`↪ Form step needs help (${r.question ? `"${String(r.question).slice(0, 80)}"` : r.status}) — escalating to AI agent.`, 'warn');
          await runAgentLoop({
            goal: `An application form step is open${r.question ? ` asking: "${r.question}"` : ''}. ` +
                  `Answer it using ONLY these candidate facts: ${profileFacts(profile)}. ` +
                  `Then click Save/Submit/Next to advance. When the form is complete or a success message appears, DONE.`,
            maxSteps: JA.CONFIG.fallbackMaxSteps
          });
          continue;
        }
        break;
      }

      // Step didn't change twice in a row → escalate once, then give up
      if (r.contentHash && r.contentHash === lastHash) {
        sameCount++;
        if (sameCount >= 2) {
          if (await handler.detectSuccess(tab)) break;
          if (!fallbackUsed.form) {
            fallbackUsed.form = true;
            logToChat('↪ Form step is stuck — escalating to AI agent.', 'warn');
            await runAgentLoop({
              goal: `An application form overlay is open but stuck. Complete and submit it using ONLY these candidate facts: ${profileFacts(profile)}. Then DONE.`,
              maxSteps: JA.CONFIG.fallbackMaxSteps
            });
            sameCount = 0;
            continue;
          }
          break;
        }
      } else {
        sameCount = 0;
      }
      lastHash = r.contentHash || lastHash;
    }

    await sleep(800);

    // VERIFY_SUCCESS — never trust the fallback agent's DONE; check the page
    const success = await handler.detectSuccess(tab);
    if (success) {
      return { status: 'applied', reason: job.score != null ? `Match score ${job.score}` : 'Applied' };
    }
    await handler.cleanup(tab);
    return {
      status: 'failed',
      reason: JA.flags.shouldStop ? 'Stopped by user' : 'No success confirmation detected'
    };
  }

  // ── Session pipeline ──────────────────────────────────────────────
  async function runPipeline(tab, handler, profile, settings, mode) {
    // SCRAPE_LISTING
    let jobs = await handler.scrapeJobs(tab.id);
    if (!jobs.length) {
      logToChat('No job cards found — trying an agent-assisted scroll...', 'warn');
      await runAgentLoop({
        goal: 'Scroll down to reveal the job listing cards on this page. Do NOT click anything. When job cards are visible, DONE.',
        maxSteps: 3
      });
      jobs = await handler.scrapeJobs(tab.id);
    }
    if (!jobs.length) {
      logToChat('✕ No jobs found on this page. Open a job listing/search results page and try again.', 'error');
      return;
    }
    logToChat(`Found ${jobs.length} job(s) on this page.`, 'done');

    // Dedup against application history and within this page's scrape
    const processedMap = await JA.store.getProcessedMap();
    const freshJobs = [];
    const seenKeys = new Set();
    for (const job of jobs) {
      const key = JA.store.jobKey(job);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const prior = processedMap.get(key);
      if (prior) {
        logToChat(`⏭ Already ${prior.status}: ${job.title} @ ${job.company}`, 'warn');
      } else {
        freshJobs.push(job);
      }
    }
    if (!freshJobs.length) {
      logToChat('All listed jobs are already in your application history.', 'done');
      return;
    }

    // SCORE_JOBS (deferred to detail view when the handler requires it)
    const counts = { applied: 0, skipped: 0, failed: 0 };
    const matched = [];
    if (!handler.needsDetailForScoring) {
      logToChat(`Scoring ${freshJobs.length} job(s) against your profile...`, 'step');
      for (const job of freshJobs) {
        if (JA.flags.shouldStop) { summary(counts); return; }
        const v = await evaluateJob(job, profile);
        job.score = v.score; job.match = v.match; job.matchReason = v.reason;
        const ok = v.match && v.score >= settings.matchThreshold;
        logToChat(`[${v.score}] ${ok ? '✓' : '✗'} ${job.title} @ ${job.company} — ${v.reason}`, ok ? 'done' : 'warn');
        if (ok) {
          matched.push(job);
        } else {
          counts.skipped++;
          if (mode !== 'dry-run') await record(job, 'skipped', v.reason);
        }
      }
    } else {
      matched.push(...freshJobs);
    }

    // DRY RUN → report and stop (nothing recorded, nothing clicked)
    if (mode === 'dry-run') {
      logToChat(`Dry run complete — would apply to ${matched.length}, would skip ${counts.skipped}. Nothing was submitted.`, 'done');
      matched.forEach(j => logToChat(`WOULD APPLY: ${j.title} @ ${j.company}${j.score != null ? ` (score ${j.score})` : ''}`, 'step'));
      return;
    }

    if (!matched.length) { summary(counts); return; }

    // CONFIRM before auto mode
    if (mode === 'auto' && settings.confirmBeforeAuto) {
      const choice = await awaitUserChoice(
        `Auto mode will apply to ${matched.length} job(s) with ~${Math.round(settings.applyDelayMs / 1000)}s delays between each. Continue?`,
        ['Start', 'Cancel']
      );
      if (choice !== 'Start') { logToChat('Mass apply cancelled.', 'warn'); return; }
    }

    const session = {
      active: true, mode, source: handler.name, listingUrl: tab.url,
      queue: matched, currentIndex: 0, counts,
      startedAt: new Date().toISOString()
    };
    await JA.store.saveSession(session);

    // NEXT_JOB loop
    for (let i = 0; i < matched.length; i++) {
      if (JA.flags.shouldStop) { logToChat('Stopped by user.', 'warn'); break; }
      if (counts.applied >= settings.maxApplicationsPerSession) {
        logToChat(`Session cap reached (${settings.maxApplicationsPerSession} applications).`, 'warn');
        break;
      }

      const job = matched[i];
      session.currentIndex = i;
      session.counts = counts;
      await JA.store.saveSession(session);

      if (mode === 'manual') {
        const choice = await awaitUserChoice(
          `Apply to "${job.title}" @ ${job.company}${job.score != null ? ` (score ${job.score})` : ''}?`,
          ['Apply', 'Skip', 'Stop']
        );
        if (choice === 'Stop') { JA.flags.shouldStop = true; break; }
        if (choice !== 'Apply') {
          counts.skipped++;
          await record(job, 'skipped', 'Skipped by user');
          continue;
        }
      }

      logToChat(`▶ Job ${i + 1}/${matched.length}: ${job.title} @ ${job.company}`, 'step');

      let outcome;
      try {
        outcome = await withTimeout(
          applyToJob(tab, handler, job, profile, settings),
          settings.perJobTimeoutMs
        );
      } catch (e) {
        outcome = { status: 'failed', reason: e.message };
      }
      if (outcome.status === 'timeout') {
        await handler.cleanup(tab);
        outcome = { status: 'failed', reason: `Timed out after ${Math.round(settings.perJobTimeoutMs / 1000)}s` };
      }

      counts[outcome.status === 'applied' ? 'applied' : outcome.status === 'skipped' ? 'skipped' : 'failed']++;
      await record(job, outcome.status === 'timeout' ? 'failed' : outcome.status, outcome.reason);
      const icon = outcome.status === 'applied' ? '✓ Applied' : outcome.status === 'skipped' ? '⏭ Skipped' : '⚠ Failed';
      const tone = outcome.status === 'applied' ? 'done' : outcome.status === 'skipped' ? 'warn' : 'error';
      logToChat(`${icon}: ${job.title} @ ${job.company} — ${outcome.reason}`, tone);

      // DELAY + return to the listing before the next job
      if (i < matched.length - 1 && !JA.flags.shouldStop) {
        await backToListing(tab, session.listingUrl);
        const secs = Math.max(1, Math.round(settings.applyDelayMs / 1000));
        logToChat(`⏳ Waiting ${secs}s before the next job...`, 'step');
        for (let w = 0; w < secs && !JA.flags.shouldStop; w++) await sleep(1000);
      }
    }

    // Keep the session if the user stopped mid-way so it can be resumed;
    // clear it on natural completion.
    if (JA.flags.shouldStop) {
      session.counts = counts;
      await JA.store.saveSession(session);
      logToChat('Session paused — type `resume` (or reopen the panel) to continue.', 'warn');
    } else {
      await JA.store.clearSession();
    }
    summary(counts);
  }

  function summary(counts) {
    logToChat(
      `Session complete — Applied: ${counts.applied} | Skipped: ${counts.skipped} | Failed: ${counts.failed}`,
      'done'
    );
  }

  // ── Entry point ───────────────────────────────────────────────────
  async function start({ mode }) {
    const profile = await JA.store.getProfile();
    const settings = await JA.store.getSettings();

    if (!Object.keys(profile.skills || {}).length && !(profile.applyList || []).length) {
      logToChat('⚠ No profile configured. Open Settings (⚙) and add your skills and matching criteria first.', 'warn');
      return;
    }

    const tab = await getActiveTab();
    if (!tab) { logToChat('No active tab found.', 'error'); return; }

    const handler = detectHandler(tab.url || '');
    if (!handler) {
      logToChat('The active tab is not a supported job listing page (Naukri or LinkedIn Jobs).', 'warn');
      return;
    }

    logToChat(`🚀 Mass apply — site: ${handler.name}, mode: ${mode}`, 'step');
    try { await chrome.tabs.sendMessage(tab.id, { type: 'START_AGENT' }); } catch (e) {}
    try {
      await runPipeline(tab, handler, profile, settings, mode);
    } finally {
      try { await chrome.tabs.sendMessage(tab.id, { type: 'STOP_AGENT' }); } catch (e) {}
    }
  }

  // Resume an interrupted session. Completed jobs are already in history, so
  // re-running the pipeline in the saved mode naturally skips them (dedup) and
  // retries anything left. Navigates back to the saved listing first.
  async function resume() {
    const session = await JA.store.getSession();
    if (!session || !session.active) {
      logToChat('No interrupted session to resume.', 'info');
      return;
    }
    const tab = await getActiveTab();
    if (tab && session.listingUrl && tab.url !== session.listingUrl) {
      try {
        await chrome.tabs.update(tab.id, { url: session.listingUrl });
        await waitUntilTabComplete(tab.id);
        await sleep(800);
      } catch (e) {}
    }
    const done = session.counts || { applied: 0, skipped: 0, failed: 0 };
    logToChat(`Resuming session (was at job ${(session.currentIndex || 0) + 1}/${(session.queue || []).length}, so far ${done.applied} applied).`, 'step');
    await start({ mode: session.mode || 'auto' });
  }

  async function hasActiveSession() {
    const s = await JA.store.getSession();
    return !!(s && s.active);
  }

  return { start, resume, hasActiveSession };
})();
