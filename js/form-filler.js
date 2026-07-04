// form-filler.js - Deterministic form-step scraping and filling for
// application overlays (Naukri drawer, LinkedIn Easy Apply modal)

// Scrape the current form step inside the active overlay. Fields get stamped
// with data-maf-id attributes so they can be targeted by executeAction.
async function scrapeFormStep(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
      const visible = el => {
        const st = window.getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' &&
               el.offsetWidth > 0 && el.offsetHeight > 0;
      };

      // Locate the active overlay container
      const candidates = [
        '.jobs-easy-apply-modal', '.naukri-drawer', '[role="dialog"]',
        '[aria-modal="true"]', '[class*="drawer"]', '[class*="modal"]'
      ];
      let overlay = null;
      for (const sel of candidates) {
        const el = [...document.querySelectorAll(sel)].find(visible);
        if (el) { overlay = el; break; }
      }
      if (!overlay) return { overlayPresent: false };

      // Text of the closest preceding sibling (walking up) — used as the
      // question for inputs whose label is just a placeholder
      const precedingText = (el) => {
        let node = el;
        for (let depth = 0; depth < 4 && node && node !== overlay; depth++) {
          let prev = node.previousElementSibling;
          while (prev) {
            const t = clean(prev.innerText);
            if (t && !prev.querySelector('input, select, textarea, button')) {
              return t.slice(0, 250);
            }
            prev = prev.previousElementSibling;
          }
          node = node.parentElement;
        }
        return '';
      };

      let n = 0;
      const stamp = el => {
        const id = `maf-${++n}`;
        el.setAttribute('data-maf-id', id);
        return `[data-maf-id="${id}"]`;
      };

      const fields = [];

      // Radio groups (grouped by name)
      const groups = {};
      [...overlay.querySelectorAll('input[type="radio"]')].forEach(r => {
        if (!visible(r) && !visible(r.parentElement)) return;
        (groups[r.name || '__unnamed'] = groups[r.name || '__unnamed'] || []).push(r);
      });
      for (const group of Object.values(groups)) {
        const options = group.map(r => {
          let label = '';
          if (r.id) {
            const l = overlay.querySelector(`label[for="${r.id}"]`);
            if (l) label = clean(l.innerText);
          }
          if (!label && r.closest('label')) label = clean(r.closest('label').innerText);
          if (!label) label = r.value;
          return { text: label, selector: stamp(r), checked: r.checked };
        });
        const legend = group[0].closest('fieldset')?.querySelector('legend');
        const question = legend ? clean(legend.innerText)
          : precedingText(group[0].closest('div, label') || group[0]);
        fields.push({ kind: 'radio', label: question, question, options,
                      required: group.some(r => r.required) });
      }

      // Text inputs / textareas
      [...overlay.querySelectorAll(
        'input[type="text"], input[type="number"], input[type="tel"], ' +
        'input[type="email"], input:not([type]), textarea'
      )].forEach(inp => {
        if (!visible(inp)) return;
        let label = '';
        if (inp.id) {
          const l = overlay.querySelector(`label[for="${inp.id}"]`);
          if (l) label = clean(l.innerText);
        }
        if (!label) label = inp.placeholder || inp.name || inp.getAttribute('aria-label') || '';
        const question = precedingText(inp) || label;
        fields.push({
          kind: inp.tagName === 'TEXTAREA' ? 'textarea' : 'text',
          label, question,
          selector: stamp(inp),
          currentValue: inp.value,
          required: inp.required
        });
      });

      // Selects
      [...overlay.querySelectorAll('select')].forEach(sel => {
        if (!visible(sel)) return;
        let label = '';
        if (sel.id) {
          const l = overlay.querySelector(`label[for="${sel.id}"]`);
          if (l) label = clean(l.innerText);
        }
        if (!label) label = sel.name || sel.getAttribute('aria-label') || '';
        const question = precedingText(sel) || label;
        const options = [...sel.options]
          .filter(o => clean(o.textContent) && !/^select/i.test(clean(o.textContent)))
          .map(o => ({ text: clean(o.textContent), value: o.value }));
        fields.push({
          kind: 'select', label, question,
          selector: stamp(sel),
          options,
          currentValue: sel.value && !/^select/i.test(clean(sel.selectedOptions[0]?.textContent || '')) ? sel.value : '',
          required: sel.required
        });
      });

      // Visible buttons in the overlay
      const buttons = [...overlay.querySelectorAll('button, input[type="submit"], a.btn, [role="button"]')]
        .filter(visible)
        .map(b => ({ text: clean(b.innerText || b.value || b.getAttribute('aria-label') || ''), selector: stamp(b) }))
        .filter(b => b.text);

      const overlayText = overlay.innerText || '';
      return {
        overlayPresent: true,
        headerText: clean(overlay.querySelector('h1, h2, h3, [class*="header"]')?.innerText || ''),
        questionText: clean(overlayText).slice(0, 300),
        fields,
        buttons,
        successText: /application successful|successfully applied|application (was )?sent|applied successfully|your application was sent/i.test(overlayText),
        contentHash: overlayText.length + ':' + clean(overlayText).slice(0, 100)
      };
    }
  });
  return (results && results[0] && results[0].result) || { overlayPresent: false };
}

// Decide a field's value from the profile. Returns null when unresolvable
// (caller then tries generateAnswer, then escalates to the fallback agent).
function resolveAnswer(field, profile) {
  const q = `${field.question || ''} ${field.label || ''}`.toLowerCase();
  if (!q.trim()) return null;

  // 1. Canned answers — longest keyword wins
  const keys = Object.keys(profile.answers || {}).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (k && q.includes(k.toLowerCase())) return profile.answers[k];
  }

  // 2. Built-in profile mapping
  if (/notice/.test(q) && profile.noticePeriod) return profile.noticePeriod;
  if (/current\s*(ctc|salary|compensation)/.test(q) && profile.currentCTC) return profile.currentCTC;
  if (/expected\s*(ctc|salary|compensation)/.test(q) && profile.expectedCTC) return profile.expectedCTC;
  if (/relocat|willing to move|living in|based in|located in|ready to move/.test(q)) {
    return profile.relocation ? 'Yes' : 'No';
  }
  if (/(available|availability).*(interview|join)|interview.*(availab|mode)/.test(q) && profile.interviewAvailability) {
    return profile.interviewAvailability;
  }
  if (/experience|years|yrs/.test(q)) {
    for (const [skill, years] of Object.entries(profile.skills || {})) {
      if (skill && q.includes(skill.toLowerCase())) return String(years);
    }
    if (/total|overall|software|professional/.test(q)) {
      const all = Object.values(profile.skills || {});
      if (all.length) return String(Math.max(...all));
    }
  }
  return null;
}

// Write an answer into a field using executeAction primitives
async function applyAnswer(tab, field, answer) {
  if (field.kind === 'radio') {
    const lower = String(answer).toLowerCase();
    const opt = field.options.find(o => o.text.toLowerCase() === lower)
      || field.options.find(o => o.text.toLowerCase().includes(lower) || lower.includes(o.text.toLowerCase()));
    if (!opt) return false;
    await executeAction(tab, { type: 'click', selector: opt.selector });
    return true;
  }
  if (field.kind === 'select') {
    await executeAction(tab, { type: 'select_option', selector: field.selector, value: answer });
    return true;
  }
  await executeAction(tab, { type: 'type', selector: field.selector, text: String(answer) });
  return true;
}

// Buttons that advance a form step, in priority order. 'cancel'/'back'/
// 'discard'/close glyphs are never advance candidates.
const ADVANCE_PRIORITY = [
  'submit application', 'submit', 'review', 'save', 'next', 'continue', 'done', 'close & return'
];

function pickAdvanceButton(buttons) {
  const usable = buttons.filter(b => {
    const t = b.text.toLowerCase();
    return t && !/cancel|back|discard|dismiss|^[×x✕]$/.test(t);
  });
  for (const want of ADVANCE_PRIORITY) {
    const exact = usable.find(b => b.text.toLowerCase() === want);
    if (exact) return exact;
    const starts = usable.find(b => b.text.toLowerCase().startsWith(want));
    if (starts) return starts;
  }
  return null;
}

// Fill and advance ONE form step.
// Returns { status: 'success'|'no_overlay'|'advanced'|'unresolved'|'no_advance', ... }
async function fillFormStep(tab, job, profile) {
  const step = await scrapeFormStep(tab.id);
  if (!step.overlayPresent) return { status: 'no_overlay' };
  if (step.successText) return { status: 'success', step };

  for (const field of step.fields) {
    if (JA.flags.shouldStop) return { status: 'no_overlay' };
    if (field.kind === 'radio' && field.options.some(o => o.checked)) continue;
    if (field.currentValue) continue;

    let answer = resolveAnswer(field, profile);

    // A resolved answer that doesn't match any option (e.g. "6" for a Yes/No
    // question) can't be clicked — let the LLM pick among the options instead
    if (answer != null && field.options && field.options.length) {
      const lower = String(answer).toLowerCase();
      const fits = field.options.some(o =>
        o.text.toLowerCase() === lower ||
        o.text.toLowerCase().includes(lower) ||
        lower.includes(o.text.toLowerCase()));
      if (!fits) answer = null;
    }

    if (answer == null) {
      try {
        answer = await generateAnswer(field, step.questionText, job, profile);
        logToChat(`🧠 LLM answered "${(field.question || field.label || '').slice(0, 60)}" → "${String(answer).slice(0, 60)}"`, 'step');
      } catch (e) {
        return { status: 'unresolved', question: field.question || field.label || step.questionText, step };
      }
    }

    const ok = await applyAnswer(tab, field, answer);
    if (!ok) return { status: 'unresolved', question: field.question || field.label, step };
    await sleep(400 + Math.floor(Math.random() * 600));
  }

  const advBtn = pickAdvanceButton(step.buttons);
  if (!advBtn) return { status: 'no_advance', step };

  // Debug flag: stop right before a final "Submit application" click so a
  // real-site run can be inspected without actually submitting
  if (JA.CONFIG.stopBeforeSubmit && /^submit/i.test(advBtn.text)) {
    logToChat('🛑 stopBeforeSubmit is on — leaving the form open at the final submit step.', 'warn');
    return { status: 'stopped_before_submit', step };
  }

  await executeAction(tab, { type: 'click', selector: advBtn.selector });
  await sleep(1200);
  return { status: 'advanced', contentHash: step.contentHash, advanced: advBtn.text, step };
}
