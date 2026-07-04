// sites/linkedin.js - LinkedIn Jobs handler (Easy Apply only).
// Descriptions load only in the detail pane, so scoring is deferred until
// after OPEN_JOB (needsDetailForScoring). Plain "Apply" buttons are external
// ATS redirects and are skipped.

JA.sites.linkedin = {
  name: 'linkedin',
  needsDetailForScoring: true,

  matches(url) {
    return /linkedin\.com\/jobs/i.test(url) || /linkedin-mock\.html/i.test(url);
  },

  // Scroll the (virtualized) results pane to hydrate cards, then extract.
  async scrapeJobs(tabId) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
        const wait = ms => new Promise(r => setTimeout(r, ms));

        // Find the scrollable ancestor of the job cards (results pane)
        let scroller = document.querySelector('.jobs-search-results-list');
        if (!scroller) {
          const anyCard = document.querySelector('li[data-occludable-job-id]');
          let p = anyCard && anyCard.parentElement;
          while (p && p !== document.body) {
            if (p.scrollHeight > p.clientHeight + 50) { scroller = p; break; }
            p = p.parentElement;
          }
        }
        for (let i = 1; i <= 4; i++) {
          if (scroller) scroller.scrollTop = (scroller.scrollHeight * i) / 4;
          else window.scrollBy(0, 800);
          await wait(800);
        }
        if (scroller) scroller.scrollTop = 0;
        await wait(500);

        let cards = [...document.querySelectorAll('li[data-occludable-job-id]')];
        if (!cards.length) {
          // Fallback: group /jobs/view/ links by their card ancestor
          const seen = new Set();
          cards = [...document.querySelectorAll('a[href*="/jobs/view/"]')]
            .map(a => a.closest('li, [class*="job-card"]') || a)
            .filter(c => !seen.has(c) && seen.add(c));
        }

        const jobs = [];
        let n = 0;
        for (const card of cards) {
          const link = card.querySelector?.(
            'a.job-card-list__title, a.job-card-container__link, a[href*="/jobs/view/"]'
          ) || (card.tagName === 'A' ? card : null);
          if (!link) continue;
          const title = clean(link.innerText).split('\n')[0];
          if (!title) continue;

          const company = clean(card.querySelector?.(
            '.artdeco-entity-lockup__subtitle, [class*="subtitle"], [class*="company-name"]'
          )?.innerText || '');
          const jobId = card.getAttribute?.('data-occludable-job-id')
            || ((link.href || '').match(/jobs\/view\/(\d+)/) || [])[1]
            || null;

          const massId = `mass-${++n}`;
          link.setAttribute('data-mass-apply-id', massId);
          jobs.push({
            jobId, title, company,
            skills: [], description: '',   // description loads in the detail pane
            url: link.href || '',
            massId,
            source: 'linkedin'
          });
        }
        return jobs;
      }
    });
    return (results && results[0] && results[0].result) || [];
  },

  // Clicking a card swaps the right-hand detail pane (SPA) or navigates
  // to /jobs/view/ — both are fine.
  async openJob(tab, job) {
    await executeAction(tab, { type: 'click', selector: `[data-mass-apply-id="${job.massId}"]` });
    await sleep(2000);
    await waitUntilTabComplete(tab.id);

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        return !!document.querySelector(
          '.jobs-details__main-content, .jobs-unified-top-card, ' +
          '.job-details-jobs-unified-top-card__job-title, .jobs-description'
        ) || /jobs\/view\//.test(location.href);
      }
    });
    return { ok: !!(results && results[0] && results[0].result) };
  },

  // Description text from the detail pane, for deferred scoring
  async getDetailDescription(tab) {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const el = document.querySelector(
          '.jobs-description__content, [class*="jobs-description"], #job-details'
        );
        return el ? el.innerText.replace(/\s+/g, ' ').trim().slice(0, 1500) : '';
      }
    });
    return (results && results[0] && results[0].result) || '';
  },

  // Only Easy Apply is automated; a plain "Apply" button opens an external ATS
  async startApply(tab) {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const visible = el => {
          const st = window.getComputedStyle(el);
          return st.display !== 'none' && st.visibility !== 'hidden' && el.offsetWidth > 0 && !el.disabled;
        };
        const btns = [...document.querySelectorAll('button, a')].filter(visible);
        const easy = btns.find(b => /easy apply/i.test(b.innerText || ''));
        if (easy) {
          easy.setAttribute('data-mass-apply-target', 'apply');
          return { found: true };
        }
        const plain = btns.find(b =>
          /^apply\b/i.test((b.innerText || '').trim()) ||
          (b.className || '').includes('jobs-apply-button'));
        if (plain) return { external: true };
        return { notFound: true };
      }
    });
    const r = (results && results[0] && results[0].result) || {};
    if (r.external) return { ok: false, external: true };
    if (!r.found) return { ok: false };

    await executeAction(tab, { type: 'click', selector: '[data-mass-apply-target="apply"]' });
    await sleep(2000);
    return { ok: true, overlay: await checkOverlayPresent(tab.id) };
  },

  // "Application sent" confirmation dialog → success; close it with Done/Dismiss
  async detectSuccess(tab) {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const dialogs = [...document.querySelectorAll('[role="dialog"], .artdeco-modal')];
        const text = dialogs.map(d => d.innerText || '').join(' ');
        if (!/application sent|your application was sent|successfully applied/i.test(text)) return false;
        const done = [...document.querySelectorAll('button')].find(b =>
          /^(done|dismiss)$/i.test((b.innerText || '').trim()) ||
          /dismiss/i.test(b.getAttribute('aria-label') || ''));
        if (done) done.click();
        return true;
      }
    });
    return !!(results && results[0] && results[0].result);
  },

  // Dismiss the Easy Apply modal; if LinkedIn offers to save the draft,
  // click Discard so the next job starts clean.
  async cleanup(tab) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const dismiss = [...document.querySelectorAll('button')].find(b =>
            /dismiss/i.test(b.getAttribute('aria-label') || ''));
          if (dismiss) dismiss.click();
        }
      });
      await sleep(1200);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const discard = [...document.querySelectorAll('button')].find(b =>
            /^discard$/i.test((b.innerText || '').trim()));
          if (discard) discard.click();
        }
      });
      await sleep(800);
    } catch (e) {}
  }
};
