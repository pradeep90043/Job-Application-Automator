// sites/naukri.js - Naukri.com handler (also drives the local mock portal)

JA.sites.naukri = {
  name: 'naukri',
  needsDetailForScoring: false,

  matches(url) {
    return /naukri\.com/i.test(url) ||
           /naukri-mock\.html/i.test(url) ||
           (/localhost|127\.0\.0\.1/.test(url) && /page=/.test(url));
  },

  // Extract job cards from the listing page. Stamps each card's clickable
  // title with data-mass-apply-id for precise clicking later.
  async scrapeJobs(tabId) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
        const visible = el => {
          const st = window.getComputedStyle(el);
          return st.display !== 'none' && st.visibility !== 'hidden' && el.offsetWidth > 0;
        };
        const jobs = [];
        let n = 0;

        // Layer 1: real Naukri SRP cards. Layer 2: mock/generic cards.
        let cards = [...document.querySelectorAll('.srp-jobtuple-wrapper, article.jobTuple, .cust-job-tuple')];
        let layer = 'naukri';
        if (!cards.length) {
          cards = [...document.querySelectorAll('.card')].filter(c =>
            c.querySelector('.job-title, h2, h3'));
          layer = 'generic';
        }
        // Layer 3: cursor-pointer heuristic inside list-like containers
        if (!cards.length) {
          const containers = document.querySelectorAll('[class*="list"], [class*="results"], [class*="cards"], ul, ol');
          for (const cont of containers) {
            const kids = [...cont.children].filter(ch =>
              ['li','div','article'].includes(ch.tagName.toLowerCase()) &&
              window.getComputedStyle(ch).cursor === 'pointer' &&
              clean(ch.innerText).length > 30);
            if (kids.length >= 2) { cards = kids; layer = 'heuristic'; break; }
          }
        }

        // Drop cards nested inside another matched card: on the real SRP,
        // .cust-job-tuple sits inside .srp-jobtuple-wrapper, so the combined
        // selector matches every job twice.
        cards = cards.filter(c => !cards.some(o => o !== c && o.contains(c)));

        const seen = new Set();
        for (const card of cards) {
          if (!visible(card)) continue;
          let titleEl, company = '', skills = [], desc = '', href = '', jobId = null;

          if (layer === 'naukri') {
            titleEl = card.querySelector('a.title, a[class*="title"]');
            company = clean(card.querySelector('.comp-name, a.subTitle, [class*="comp-name"]')?.innerText);
            skills = [...card.querySelectorAll('.tag-li, ul.tags li, [class*="tag-li"]')].map(t => clean(t.innerText));
            desc = clean(card.querySelector('.job-desc, [class*="job-desc"]')?.innerText);
            href = titleEl?.href || '';
            const m = href.match(/-(\d{6,})(?:[?#]|$)/);
            jobId = m ? m[1] : null;
          } else {
            titleEl = card.querySelector('.job-title, h2, h3, a');
            company = clean(card.querySelector('.company, [class*="company"], [class*="comp"]')?.innerText);
            skills = [...card.querySelectorAll('.tag, [class*="tag"]')].map(t => clean(t.innerText)).filter(Boolean);
            desc = clean(card.querySelector('.desc, p')?.innerText);
            const idm = (titleEl?.id || card.id || '').match(/(\d+)/);
            jobId = idm ? idm[1] : null;
          }

          if (!titleEl) continue;
          const title = clean(titleEl.innerText);
          if (!title) continue;

          const dupKey = jobId || `${title}|${company}`.toLowerCase();
          if (seen.has(dupKey)) continue;
          seen.add(dupKey);

          const massId = `mass-${++n}`;
          titleEl.setAttribute('data-mass-apply-id', massId);
          jobs.push({
            jobId, title, company, skills,
            description: desc.slice(0, 600),
            url: href,
            massId,
            source: 'naukri'
          });
        }
        return jobs;
      }
    });
    return (results && results[0] && results[0].result) || [];
  },

  // Open the job detail IN THE SAME TAB and wait for it to load, absorbing
  // intermediate tracking/redirect hops. Real Naukri title links carry
  // target="_blank"; clicking them would strand the pipeline on the listing
  // tab, so prefer direct navigation to the href and only fall back to a
  // click (with target stripped) when no href was scraped.
  async openJob(tab, job) {
    if (/^https?:\/\//i.test(job.url || '')) {
      await chrome.tabs.update(tab.id, { url: job.url });
    } else {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [job.massId],
        func: (id) => {
          const el = document.querySelector(`[data-mass-apply-id="${id}"]`);
          const link = el && (el.closest('a') || el);
          if (link && link.target) link.target = '_self';
        }
      });
      await executeAction(tab, { type: 'click', selector: `[data-mass-apply-id="${job.massId}"]` });
    }
    await sleep(1000);
    await waitUntilTabComplete(tab.id);

    // Absorb redirect hops (mock's DoubleClick page, real tracking URLs)
    for (let i = 0; i < 8; i++) {
      let t;
      try { t = await chrome.tabs.get(tab.id); } catch(e) { break; }
      const url = (t.url || '').toLowerCase();
      const isTransient = /redirect|doubleclick|track|adservice/.test(url) || t.status !== 'complete';
      if (!isTransient) {
        await handleNavigationFilter(t);
        break;
      }
      await sleep(800);
    }
    await waitUntilTabComplete(tab.id);

    // Verify detail loaded: Apply-like button or a detail URL
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const hasApply = [...document.querySelectorAll('button, a')].some(b =>
          /^(apply|easy apply|apply now)/i.test((b.innerText || '').trim()));
        return hasApply || /page=detail|job-listings/.test(location.href);
      }
    });
    return { ok: !!(results && results[0] && results[0].result) };
  },

  // Find and click the Apply button. "Apply on company site" → external ATS.
  async startApply(tab) {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const visible = el => {
          const st = window.getComputedStyle(el);
          return st.display !== 'none' && st.visibility !== 'hidden' && el.offsetWidth > 0 && !el.disabled;
        };
        const btns = [...document.querySelectorAll('button, a')].filter(b => {
          const t = (b.innerText || '').trim().toLowerCase();
          // "I am interested" = walk-in listings' apply action
          return visible(b) && /^(apply|easy apply|apply now|i am interested)/.test(t);
        });
        const internal = btns.find(b => !/company site/i.test(b.innerText));
        const external = btns.find(b => /company site/i.test(b.innerText));
        if (!internal && external) return { external: true };
        if (!internal) return { notFound: true };
        internal.setAttribute('data-mass-apply-target', 'apply');
        return { found: true };
      }
    });
    const r = (results && results[0] && results[0].result) || {};
    if (r.external) return { ok: false, external: true };
    if (!r.found) return { ok: false };

    await executeAction(tab, { type: 'click', selector: '[data-mass-apply-target="apply"]' });
    await sleep(1500);
    return { ok: true, overlay: await checkOverlayPresent(tab.id) };
  },

  // Success = success URL, or success text on page/drawer. Also clicks the
  // mock's "Close & Return to Listings" / "Back to Listings" follow-ups.
  async detectSuccess(tab) {
    let t;
    try { t = await chrome.tabs.get(tab.id); } catch(e) { return false; }
    if ((t.url || '').includes('page=success')) return true;

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const text = document.body.innerText || '';
        // Real Naukri: "Applied to 'Job Title'" banner, or the detail page's
        // Apply button flips to a static "Applied" chip (#already-applied)
        const phrases = /application successful|successfully applied|applied successfully|application (was )?sent|applied to ['"‘“]|successfully registered|registered for (this )?walk/i;
        const chip = document.querySelector('#already-applied, .already-applied, [class*="already-applied"]');
        if (!phrases.test(text) && !chip) return false;
        const followUp = [...document.querySelectorAll('button, a')].find(b =>
          /close & return|back to listings/i.test(b.innerText || ''));
        if (followUp) followUp.click();
        return true;
      }
    });
    return !!(results && results[0] && results[0].result);
  },

  // Close any open drawer/modal so the next job starts from a clean state
  async cleanup(tab) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const close = document.querySelector(
            '.naukri-drawer .close, [class*="drawer"] [class*="close"], ' +
            '[role="dialog"] [class*="close"], [aria-label*="lose"], .cross');
          if (close) close.click();
        }
      });
      await sleep(800);
    } catch(e) {}
  }
};
