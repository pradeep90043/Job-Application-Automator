// actions.js - Browser action executor and navigation/wait helpers

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Execute Action on active tab ────────────────────────────────────
async function executeAction(tab, action) {
  switch (action.type) {

    case 'click':
      if (action.selector) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (sel) => {
            const el = document.querySelector(sel) || document.querySelectorAll(sel.split(',')[0])[0];
            if (!el) return;

            // Scroll element into view before clicking
            el.scrollIntoView({ behavior: 'instant', block: 'nearest' });
            await new Promise(r => setTimeout(r, 150));

            const rect = el.getBoundingClientRect();
            const targetX = Math.round(rect.left + rect.width / 2);
            const targetY = Math.round(rect.top + rect.height / 2);

            // Create or retrieve virtual cursor
            let cursor = document.getElementById('agent-virtual-cursor');
            let startX = window.innerWidth / 2;
            let startY = window.innerHeight / 2;

            if (cursor) {
              const curRect = cursor.getBoundingClientRect();
              startX = curRect.left + 5;
              startY = curRect.top + 5;
            } else {
              cursor = document.createElement('div');
              cursor.id = 'agent-virtual-cursor';
              cursor.style.position = 'fixed';
              cursor.style.left = `${startX}px`;
              cursor.style.top = `${startY}px`;
              cursor.style.width = '18px';
              cursor.style.height = '18px';
              cursor.style.zIndex = '2147483646';
              cursor.style.pointerEvents = 'none';
              cursor.style.transition = 'left 0.7s cubic-bezier(0.25, 1, 0.5, 1), top 0.7s cubic-bezier(0.25, 1, 0.5, 1)';
              cursor.innerHTML = `
                <svg viewBox="0 0 24 24" width="100%" height="100%">
                  <path fill="#f97316" stroke="#ffffff" stroke-width="1.5" d="M4.5 3v15.2l3.8-3.8 2.9 6.8 2.6-1.1-2.9-6.8 5.3-.1z"/>
                </svg>
              `;
              document.body.appendChild(cursor);
            }

            // Move cursor to target
            cursor.getBoundingClientRect(); // force reflow
            cursor.style.left = `${targetX - 5}px`;
            cursor.style.top = `${targetY - 5}px`;

            // Wait for movement animation
            await new Promise(r => setTimeout(r, 750));

            // Visual ripple indicator
            const marker = document.createElement('div');
            marker.style.position = 'fixed';
            marker.style.left = `${targetX - 10}px`;
            marker.style.top = `${targetY - 10}px`;
            marker.style.width = '20px';
            marker.style.height = '20px';
            marker.style.borderRadius = '50%';
            marker.style.background = 'rgba(249, 115, 22, 0.4)';
            marker.style.border = '2px solid #f97316';
            marker.style.pointerEvents = 'none';
            marker.style.zIndex = '2147483645';
            marker.style.transition = 'transform 0.5s ease-out, opacity 0.5s ease-out';
            document.body.appendChild(marker);
            setTimeout(() => {
              marker.style.transform = 'scale(2.5)';
              marker.style.opacity = '0';
            }, 50);
            setTimeout(() => marker.remove(), 600);

            // Dispatch full mouse event sequence (works on React/Vue/Angular SPAs)
            const eventProps = {
              bubbles: true, cancelable: true, view: window,
              clientX: targetX, clientY: targetY,
              screenX: targetX, screenY: targetY
            };
            const pointerProps = { ...eventProps, pointerId: 1, pointerType: 'mouse', isPrimary: true };

            el.focus?.();
            el.dispatchEvent(new PointerEvent('pointerover', pointerProps));
            el.dispatchEvent(new MouseEvent('mouseover', eventProps));
            el.dispatchEvent(new PointerEvent('pointerdown', pointerProps));
            el.dispatchEvent(new MouseEvent('mousedown', { ...eventProps, button: 0, buttons: 1 }));
            el.dispatchEvent(new PointerEvent('pointerup', pointerProps));
            el.dispatchEvent(new MouseEvent('mouseup', { ...eventProps, button: 0, buttons: 0 }));
            if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
              el.click?.();
            } else {
              if (el.tagName === 'A' && el.target === '_blank') el.target = '_self';
              const a = el.querySelector('a');
              if (a && a.target === '_blank') a.target = '_self';
              
              el.dispatchEvent(new MouseEvent('click', { ...eventProps, button: 0, buttons: 0 }));
              el.click?.();
            }
          },
          args: [action.selector]
        });
      }
      break;

    case 'type':
      if (action.selector) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (sel, text) => {
            const el = document.querySelector(sel) || document.querySelectorAll(sel.split(',')[0])[0];
            if (!el) return;

            const rect = el.getBoundingClientRect();
            const targetX = rect.left + rect.width / 2;
            const targetY = rect.top + rect.height / 2;

            // 1. Create or retrieve virtual cursor
            let cursor = document.getElementById('agent-virtual-cursor');
            let startX = window.innerWidth / 2;
            let startY = window.innerHeight / 2;

            if (cursor) {
              const curRect = cursor.getBoundingClientRect();
              startX = curRect.left + 5;
              startY = curRect.top + 5;
            } else {
              cursor = document.createElement('div');
              cursor.id = 'agent-virtual-cursor';
              cursor.style.position = 'fixed';
              cursor.style.left = `${startX}px`;
              cursor.style.top = `${startY}px`;
              cursor.style.width = '18px';
              cursor.style.height = '18px';
              cursor.style.zIndex = '2147483646';
              cursor.style.pointerEvents = 'none';
              cursor.style.transition = 'left 0.7s cubic-bezier(0.25, 1, 0.5, 1), top 0.7s cubic-bezier(0.25, 1, 0.5, 1)';
              cursor.innerHTML = `
                <svg viewBox="0 0 24 24" width="100%" height="100%">
                  <path fill="#a78bfa" stroke="#ffffff" stroke-width="1.5" d="M4.5 3v15.2l3.8-3.8 2.9 6.8 2.6-1.1-2.9-6.8 5.3-.1z"/>
                </svg>
              `;
              document.body.appendChild(cursor);
            }

            // Move cursor to target
            cursor.getBoundingClientRect(); // force reflow
            cursor.style.left = `${targetX - 5}px`;
            cursor.style.top = `${targetY - 5}px`;

            // Wait for movement animation
            await new Promise(r => setTimeout(r, 750));

            // Focus indicator
            const marker = document.createElement('div');
            marker.style.position = 'fixed';
            marker.style.left = `${targetX - 10}px`;
            marker.style.top = `${targetY - 10}px`;
            marker.style.width = '20px';
            marker.style.height = '20px';
            marker.style.borderRadius = '50%';
            marker.style.background = 'rgba(167, 139, 250, 0.4)';
            marker.style.border = '2px solid #a78bfa';
            marker.style.pointerEvents = 'none';
            marker.style.zIndex = '2147483645';
            marker.style.transition = 'transform 0.5s ease-out, opacity 0.5s ease-out';
            document.body.appendChild(marker);
            setTimeout(() => {
              marker.style.transform = 'scale(2.5)';
              marker.style.opacity = '0';
            }, 50);
            setTimeout(() => marker.remove(), 600);

            el.focus?.();
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) {
              if (el.isContentEditable) {
                el.innerText = text;
              } else {
                el.value = text;
              }
              el.dispatchEvent(new Event('input',  { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          },
          args: [action.selector, action.text]
        });
      }
      break;

    case 'select_option':
      // Select a <select> option by value or visible text (case-insensitive)
      if (action.selector) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel, value) => {
            const el = document.querySelector(sel);
            if (!el || el.tagName !== 'SELECT') return false;
            const want = String(value).toLowerCase().trim();
            let matched = null;
            for (const opt of el.options) {
              const optText = opt.textContent.toLowerCase().trim();
              const optValue = String(opt.value).toLowerCase().trim();
              if (optValue === want || optText === want) { matched = opt; break; }
              if (!matched && (optText.includes(want) || want.includes(optText)) && optText) {
                matched = opt;
              }
            }
            if (!matched) return false;
            el.value = matched.value;
            el.dispatchEvent(new Event('input',  { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          },
          args: [action.selector, action.value]
        });
      }
      break;

    case 'key':
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (key) => {
          const el = document.activeElement || document.body;
          const opts = { key, code: key, bubbles: true };
          if (key === 'Enter') {
            opts.keyCode = 13;
            opts.which = 13;
          }
          el.dispatchEvent(new KeyboardEvent('keydown', opts));
          el.dispatchEvent(new KeyboardEvent('keypress', opts));
          el.dispatchEvent(new KeyboardEvent('keyup', opts));
          if (key === 'Enter' && el.form) {
            try { el.form.submit(); } catch(e) {}
          }
        },
        args: [action.key || 'Enter']
      });
      break;

    case 'scroll':
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (dir, amt) => window.scrollBy({ top: dir === 'up' ? -amt : amt, behavior: 'smooth' }),
        args: [action.direction || 'down', action.amount || 400]
      });
      break;

    case 'navigate':
      await chrome.tabs.update(tab.id, { url: action.url });
      break;

    case 'wait':
      await sleep(action.ms || 1000);
      break;

    case 'hover':
      if (action.selector) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (sel) => {
            const el = document.querySelector(sel) || document.querySelectorAll(sel.split(',')[0])[0];
            if (!el) return;

            const rect = el.getBoundingClientRect();
            const targetX = rect.left + rect.width / 2;
            const targetY = rect.top + rect.height / 2;

            // Create or retrieve virtual cursor
            let cursor = document.getElementById('agent-virtual-cursor');
            let startX = window.innerWidth / 2;
            let startY = window.innerHeight / 2;

            if (cursor) {
              const curRect = cursor.getBoundingClientRect();
              startX = curRect.left + 5;
              startY = curRect.top + 5;
            } else {
              cursor = document.createElement('div');
              cursor.id = 'agent-virtual-cursor';
              cursor.style.position = 'fixed';
              cursor.style.left = `${startX}px`;
              cursor.style.top = `${startY}px`;
              cursor.style.width = '18px';
              cursor.style.height = '18px';
              cursor.style.zIndex = '2147483646';
              cursor.style.pointerEvents = 'none';
              cursor.style.transition = 'left 0.7s cubic-bezier(0.25, 1, 0.5, 1), top 0.7s cubic-bezier(0.25, 1, 0.5, 1)';
              cursor.innerHTML = `
                <svg viewBox="0 0 24 24" width="100%" height="100%">
                  <path fill="#fbbf24" stroke="#ffffff" stroke-width="1.5" d="M4.5 3v15.2l3.8-3.8 2.9 6.8 2.6-1.1-2.9-6.8 5.3-.1z"/>
                </svg>
              `;
              document.body.appendChild(cursor);
            }

            cursor.getBoundingClientRect(); // force reflow
            cursor.style.left = `${targetX - 5}px`;
            cursor.style.top = `${targetY - 5}px`;

            await new Promise(r => setTimeout(r, 750));

            // Trigger hover events
            const opts = { bubbles: true, cancelable: true, view: window };
            el.dispatchEvent(new MouseEvent('mouseover', opts));
            el.dispatchEvent(new MouseEvent('mouseenter', opts));
            el.dispatchEvent(new MouseEvent('mousemove', opts));
          },
          args: [action.selector]
        });
      }
      break;

    case 'javascript':
      if (action.code) {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (code) => {
            try {
              // 1. Try safe text-search extraction first to avoid eval & CSP issues
              // Matches patterns like querySelectorAll(...) and includes('...')
              const includesMatch = code.match(/\.includes\(\s*['"](.*?)['"]\s*\)/);
              if (includesMatch) {
                const textToFind = includesMatch[1];
                let selector = '[class*=card],[class*=job],li,article,button,a,div,span';
                const qsaMatch = code.match(/querySelectorAll\(\s*['"](.*?)['"]\s*\)/);
                if (qsaMatch) {
                  selector = qsaMatch[1];
                }

                const els = [...document.querySelectorAll(selector)];
                const target = els.find(e => e.innerText && e.innerText.includes(textToFind));
                if (target) {
                  target.focus?.();
                  target.click?.();

                  // Also click any nested link or button inside the target
                  const nestedLink = target.querySelector('a');
                  if (nestedLink) nestedLink.click?.();
                  const nestedBtn = target.querySelector('button');
                  if (nestedBtn) nestedBtn.click?.();

                  return { success: true, result: `Safely clicked element containing "${textToFind}"` };
                }
              }

              // 2. Fallback to eval (if safe parsing didn't match or fails)
              const result = window.eval(code);
              return { success: true, result: String(result) };
            } catch (err) {
              return { success: false, error: err.message };
            }
          },
          args: [action.code]
        });

        if (results && results[0] && results[0].result) {
          const res = results[0].result;
          if (res.success) {
            logToChat(`⚡ JS Executed. Result: "${res.result}"`, 'action');
          } else {
            logToChat(`✕ JS Execution Error: ${res.error}`, 'error');
          }
        }
      }
      break;

    case 'click_text':
      if (action.text) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (text) => {
            // Find active visible overlay container if present to prioritize clicks inside it
            const findActiveOverlay = () => {
              const selectors = [
                '.nI-gNb-drawer',
                '[class*="drawer" i]',
                '[class*="modal" i]',
                '[class*="dialog" i]',
                '[class*="overlay" i]',
                '[class*="popup" i]',
                '[role="dialog"]'
              ];
              for (const sel of selectors) {
                const els = [...document.querySelectorAll(sel)];
                for (const el of els) {
                  const style = window.getComputedStyle(el);
                  const rect = el.getBoundingClientRect();
                  if (style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 50 && rect.height > 50) {
                    return el;
                  }
                }
              }
              return null;
            };

            const overlay = findActiveOverlay();
            let els = [];
            if (overlay) {
              els = [...overlay.querySelectorAll('a, button, input, label, [role="button"], li, div, span, p, h1, h2, h3, h4, td, th')].reverse();
            }
            let target = els.find(e => e.innerText && e.innerText.trim().toLowerCase() === text.trim().toLowerCase())
                      || els.find(e => e.innerText && e.innerText.toLowerCase().includes(text.toLowerCase()));

            if (!target) {
              // Fallback to entire document if not found in overlay
              const docEls = [...document.querySelectorAll('a, button, input, label, [role="button"], li, div, span, p, h1, h2, h3, h4, td, th')].reverse();
              target = docEls.find(e => e.innerText && e.innerText.trim().toLowerCase() === text.trim().toLowerCase())
                    || docEls.find(e => e.innerText && e.innerText.toLowerCase().includes(text.toLowerCase()));
            }
            if (target) {
              target.scrollIntoView({ behavior: 'instant', block: 'nearest' });
              await new Promise(r => setTimeout(r, 150));

              const rect = target.getBoundingClientRect();
              const targetX = Math.round(rect.left + rect.width / 2);
              const targetY = Math.round(rect.top + rect.height / 2);

              // 1. Create or retrieve virtual cursor
              let cursor = document.getElementById('agent-virtual-cursor');
              let startX = window.innerWidth / 2;
              let startY = window.innerHeight / 2;

              if (cursor) {
                const curRect = cursor.getBoundingClientRect();
                startX = curRect.left + 5;
                startY = curRect.top + 5;
              } else {
                cursor = document.createElement('div');
                cursor.id = 'agent-virtual-cursor';
                cursor.style.position = 'fixed';
                cursor.style.left = `${startX}px`;
                cursor.style.top = `${startY}px`;
                cursor.style.width = '18px';
                cursor.style.height = '18px';
                cursor.style.zIndex = '2147483646';
                cursor.style.pointerEvents = 'none';
                cursor.style.transition = 'left 0.7s cubic-bezier(0.25, 1, 0.5, 1), top 0.7s cubic-bezier(0.25, 1, 0.5, 1)';
                cursor.innerHTML = `
                  <svg viewBox="0 0 24 24" width="100%" height="100%">
                    <path fill="#f97316" stroke="#ffffff" stroke-width="1.5" d="M4.5 3v15.2l3.8-3.8 2.9 6.8 2.6-1.1-2.9-6.8 5.3-.1z"/>
                  </svg>
                `;
                document.body.appendChild(cursor);
              }

              // Move cursor
              cursor.getBoundingClientRect();
              cursor.style.left = `${targetX - 5}px`;
              cursor.style.top = `${targetY - 5}px`;

              await new Promise(r => setTimeout(r, 750));

              // Click ripple marker
              const marker = document.createElement('div');
              marker.style.position = 'fixed';
              marker.style.left = `${targetX - 10}px`;
              marker.style.top = `${targetY - 10}px`;
              marker.style.width = '20px';
              marker.style.height = '20px';
              marker.style.borderRadius = '50%';
              marker.style.background = 'rgba(249, 115, 22, 0.4)';
              marker.style.border = '2px solid #f97316';
              marker.style.pointerEvents = 'none';
              marker.style.zIndex = '2147483645';
              marker.style.transition = 'transform 0.5s ease-out, opacity 0.5s ease-out';
              document.body.appendChild(marker);
              setTimeout(() => {
                marker.style.transform = 'scale(2.5)';
                marker.style.opacity = '0';
              }, 50);
              setTimeout(() => marker.remove(), 600);

              const eventProps = {
                bubbles: true, cancelable: true, view: window,
                clientX: targetX, clientY: targetY,
                screenX: targetX, screenY: targetY
              };
              const pointerProps = { ...eventProps, pointerId: 1, pointerType: 'mouse', isPrimary: true };

              target.focus?.();
              target.dispatchEvent(new PointerEvent('pointerover', pointerProps));
              target.dispatchEvent(new MouseEvent('mouseover', eventProps));
              target.dispatchEvent(new PointerEvent('pointerdown', pointerProps));
              target.dispatchEvent(new MouseEvent('mousedown', { ...eventProps, button: 0, buttons: 1 }));
              target.dispatchEvent(new PointerEvent('pointerup', pointerProps));
              target.dispatchEvent(new MouseEvent('mouseup', { ...eventProps, button: 0, buttons: 0 }));

              const input = (target.tagName === 'LABEL' || target.tagName === 'DIV') ? target.querySelector('input') : (target.tagName === 'INPUT' ? target : null);
              if (input && (input.type === 'checkbox' || input.type === 'radio')) {
                input.click();
              } else {
                if (target.tagName === 'A' && target.target === '_blank') target.target = '_self';
                const a = target.querySelector('a');
                if (a && a.target === '_blank') a.target = '_self';

                target.dispatchEvent(new MouseEvent('click', { ...eventProps, button: 0, buttons: 0 }));
                target.click?.();
                if (a) a.click?.();
                const btn = target.querySelector('button');
                if (btn) btn.click?.();
              }
            }
          },
          args: [action.text]
        });
      }
      break;

    case 'type_text':
      if (action.text) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (text) => {
            let el = document.activeElement;
            if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable)) {
              const inputs = [...document.querySelectorAll('input, textarea')].filter(i => {
                const style = window.getComputedStyle(i);
                return style.display !== 'none' && style.visibility !== 'hidden' && !i.disabled;
              });
              if (inputs.length > 0) {
                el = inputs[0];
              }
            }
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
              el.scrollIntoView({ behavior: 'instant', block: 'nearest' });
              await new Promise(r => setTimeout(r, 150));

              const rect = el.getBoundingClientRect();
              const targetX = Math.round(rect.left + rect.width / 2);
              const targetY = Math.round(rect.top + rect.height / 2);

              // Create or retrieve virtual cursor
              let cursor = document.getElementById('agent-virtual-cursor');
              let startX = window.innerWidth / 2;
              let startY = window.innerHeight / 2;

              if (cursor) {
                const curRect = cursor.getBoundingClientRect();
                startX = curRect.left + 5;
                startY = curRect.top + 5;
              } else {
                cursor = document.createElement('div');
                cursor.id = 'agent-virtual-cursor';
                cursor.style.position = 'fixed';
                cursor.style.left = `${startX}px`;
                cursor.style.top = `${startY}px`;
                cursor.style.width = '18px';
                cursor.style.height = '18px';
                cursor.style.zIndex = '2147483646';
                cursor.style.pointerEvents = 'none';
                cursor.style.transition = 'left 0.7s cubic-bezier(0.25, 1, 0.5, 1), top 0.7s cubic-bezier(0.25, 1, 0.5, 1)';
                cursor.innerHTML = `
                  <svg viewBox="0 0 24 24" width="100%" height="100%">
                    <path fill="#f97316" stroke="#ffffff" stroke-width="1.5" d="M4.5 3v15.2l3.8-3.8 2.9 6.8 2.6-1.1-2.9-6.8 5.3-.1z"/>
                  </svg>
                `;
                document.body.appendChild(cursor);
              }

              // Move cursor to input
              cursor.getBoundingClientRect();
              cursor.style.left = `${targetX - 5}px`;
              cursor.style.top = `${targetY - 5}px`;

              await new Promise(r => setTimeout(r, 750));

              // Click target input to focus
              el.focus();
              const eventProps = { bubbles: true, cancelable: true, view: window };
              el.dispatchEvent(new MouseEvent('click', eventProps));

              // Clear input value
              if (el.isContentEditable) {
                el.innerText = '';
              } else {
                el.value = '';
              }
              el.dispatchEvent(new Event('input', { bubbles: true }));

              // Type character-by-character
              for (let i = 0; i < text.length; i++) {
                const char = text[i];
                if (el.isContentEditable) {
                  el.innerText += char;
                } else {
                  el.value += char;
                }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: `Key${char.toUpperCase()}`, bubbles: true }));
                el.dispatchEvent(new KeyboardEvent('keypress', { key: char, code: `Key${char.toUpperCase()}`, bubbles: true }));
                el.dispatchEvent(new KeyboardEvent('keyup', { key: char, code: `Key${char.toUpperCase()}`, bubbles: true }));
                await new Promise(r => setTimeout(r, 60)); // 60ms delay
              }
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          },
          args: [action.text]
        });
      }
      break;

    case 'go_back':
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.history.back()
      });
      break;

    case 'read_page':
      // Context already captured in DOM context extraction
      break;

    default:
      logToChat(`⚠ Unknown action: ${action.type}`, 'error');
  }
}

// ── Wait helpers ────────────────────────────────────────────────────
async function adaptiveWait(actionType) {
  let ms = 500;
  if (['click', 'type', 'key', 'navigate', 'type_text', 'click_text'].includes(actionType)) ms = 2500;
  if (actionType === 'navigate') ms = 3000;
  await sleep(ms);
}

async function waitUntilTabComplete(tabId) {
  let checkCount = 0;
  while (checkCount < 30) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') {
        await sleep(500); // Settle down time
        return;
      }
    } catch(e) {}
    await sleep(500);
    checkCount++;
  }
}

// ── Overlay / navigation-state helpers ──────────────────────────────
async function checkOverlayPresent(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        const els = [...document.querySelectorAll('*')];
        for (const el of els) {
          const style = window.getComputedStyle(el);
          const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && el.offsetWidth > 0 && el.offsetHeight > 0;
          if (!isVisible) continue;

          const role = el.getAttribute('role');
          const ariaModal = el.getAttribute('aria-modal');
          const className = el.className && typeof el.className === 'string' ? el.className.toLowerCase() : '';

          const hasRole = (role === 'dialog');
          const hasAria = (ariaModal === 'true');
          const hasClass = className.includes('drawer') || className.includes('modal') || className.includes('dialog') ||
                           className.includes('overlay') || className.includes('popup') || className.includes('questionnaire') ||
                           className.includes('bottomsheet') || className.includes('bottom-sheet');

          if (!hasRole && !hasAria && !hasClass) continue;

          // Site chrome that merely NAMES itself a drawer: Naukri's global
          // navbar (nI-gNb-*) matches "drawer" on every page — not an overlay.
          if (className.includes('ni-gnb')) continue;

          // A real overlay floats above the page and covers meaningful area
          const pos = style.position;
          const floats = pos === 'fixed' || pos === 'absolute' || pos === 'sticky';
          const area = el.offsetWidth * el.offsetHeight;
          const viewport = window.innerWidth * window.innerHeight;
          if (floats && area >= viewport * 0.10) {
            return true;
          }
        }
        return false;
      }
    });
    return results && results[0] && results[0].result === true;
  } catch(e) {
    return false;
  }
}

async function handleNavigationFilter(tab) {
  const url = tab.url || "";
  const pendingUrl = tab.pendingUrl || "";
  const title = tab.title || "";

  // Get exact window.location.href from the tab DOM to handle URL lag or iframe mismatches
  let pageUrl = url;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.location.href
    });
    if (results && results[0] && results[0].result) {
      pageUrl = results[0].result;
    }
  } catch(e) {}

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

  const isTracking = trackingKeywords.some(kw => 
    url.toLowerCase().includes(kw) || 
    pendingUrl.toLowerCase().includes(kw) ||
    pageUrl.toLowerCase().includes(kw)
  );

  if (isTracking) {
    let hostName = 'Redirect';
    try { hostName = new URL(pageUrl || pendingUrl || url).hostname; } catch(e) {}
    logToChat(`🔍 Transient/tracking page detected (${hostName}). Waiting...`, 'warn');
    await sleep(2000);

    // Re-check tab
    let checkTab = null;
    let checkUrl = "";
    try {
      checkTab = await chrome.tabs.get(tab.id);
      checkUrl = checkTab.url || checkTab.pendingUrl || "";
      const checkDOMResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.location.href
      });
      if (checkDOMResults && checkDOMResults[0] && checkDOMResults[0].result) {
        checkUrl = checkDOMResults[0].result;
      }
    } catch(e) {}

    if (checkUrl && checkUrl !== pageUrl && !trackingKeywords.some(kw => checkUrl.toLowerCase().includes(kw))) {
      logToChat(`✓ Redirected automatically. Continuing...`, 'done');
      return true;
    }

    logToChat(`↩ Tracking page didn't redirect. Navigating back...`, 'warn');
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.history.back()
      });
    } catch(e) {}
    await sleep(2000);

    // Re-check if we are still stuck on a tracking/redirect page
    try {
      let finalUrl = "";
      const finalTab = await chrome.tabs.get(tab.id);
      finalUrl = finalTab.url || finalTab.pendingUrl || "";
      const finalDOMResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.location.href
      });
      if (finalDOMResults && finalDOMResults[0] && finalDOMResults[0].result) {
        finalUrl = finalDOMResults[0].result;
      }

      const stillTracking = trackingKeywords.some(kw => finalUrl.toLowerCase().includes(kw));
      if (stillTracking) {
        // We are stuck in a redirect loop. Break out by navigating directly to last real URL!
        const lastReal = (typeof agentState !== 'undefined' && agentState.lastRealURL) ? agentState.lastRealURL : null;
        if (lastReal && (lastReal.startsWith('http://') || lastReal.startsWith('https://'))) {
          logToChat(`↩ Still stuck on tracking page. Direct navigating back to last real page: ${lastReal}`, 'warn');
          await chrome.tabs.update(tab.id, { url: lastReal });
          await sleep(2000);
        }
      }
    } catch(e) {}

    return true;
  }

  return false;
}

// CAPTCHA Detection and Handling
async function handleCaptchaCheck(tab) {
  const url = tab.url || "";
  const title = tab.title || "";

  // Check URL/title first (only if it explicitly is a captcha domain or page title)
  let isCaptcha = url.toLowerCase().includes('recaptcha/api') ||
                  url.toLowerCase().includes('captcha-delivery') ||
                  title.toLowerCase() === 'captcha' ||
                  title.toLowerCase() === 'recaptcha';

  // Visibility-aware CAPTCHA DOM check function
  const checkVisibleCaptchaInDOM = () => {
    const isElementVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && 
             style.visibility !== 'hidden' && 
             rect.width > 20 && 
             rect.height > 20;
    };

    // 1. Check visible challenge/captcha iframes
    const iframes = [...document.querySelectorAll('iframe')];
    for (const iframe of iframes) {
      const src = iframe.getAttribute('src') || '';
      if (/recaptcha|hcaptcha|turnstile|cf-challenge|arkose/i.test(src)) {
        if (isElementVisible(iframe)) {
          return true;
        }
      }
    }

    // 2. Check visible elements with captcha class/id
    const captchaElements = [...document.querySelectorAll('[class*="captcha" i], [id*="captcha" i]')];
    for (const el of captchaElements) {
      if (isElementVisible(el)) {
        return true;
      }
    }

    // 3. Check for blocking challenge page titles/content
    const docTitle = document.title.toLowerCase();
    if (docTitle.includes('attention required!') || docTitle.includes('access denied') || docTitle === 'security check') {
      return true;
    }

    // 4. Check visible challenge texts on the page
    const challengeTexts = ['verify you are human', 'please solve the captcha', 'security check: please verify'];
    const walk = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walk.nextNode()) {
      const parent = node.parentElement;
      if (parent && isElementVisible(parent)) {
        const text = node.textContent.toLowerCase();
        if (challengeTexts.some(ct => text.includes(ct)) && text.length < 200) {
          return true;
        }
      }
    }

    return false;
  };

  if (!isCaptcha) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: checkVisibleCaptchaInDOM
      });
      isCaptcha = results && results[0] && results[0].result === true;
    } catch (e) {}
  }

  if (isCaptcha) {
    logToChat(`⚠️ CAPTCHA detected! Please solve the CAPTCHA in the active tab.`, 'warn');
    setStatus(false, 'Waiting for CAPTCHA...');

    let solved = false;
    while (!JA.flags.shouldStop && !solved) {
      await sleep(2000);
      try {
        const checkTab = await chrome.tabs.get(tab.id);
        const checkUrl = checkTab.url || "";
        const checkTitle = checkTab.title || "";
        let stillCaptcha = checkUrl.toLowerCase().includes('recaptcha/api') ||
                           checkUrl.toLowerCase().includes('captcha-delivery') ||
                           checkTitle.toLowerCase() === 'captcha' ||
                           checkTitle.toLowerCase() === 'recaptcha';

        if (!stillCaptcha) {
          const checkDOM = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: checkVisibleCaptchaInDOM
          }).then(r => r?.[0]?.result).catch(() => false);
          
          stillCaptcha = checkDOM;
        }

        if (!stillCaptcha) {
          solved = true;
        }
      } catch (e) {
        break; // Tab closed or error
      }
    }

    logToChat(`✓ CAPTCHA solved. Continuing...`, 'done');
    setStatus(true);
    return true;
  }

  return false;
}

// Capture the visible area of the agent's tab as a JPEG data URL for vision
// analysis. Returns null on failure (restricted pages, throttling, etc.).
async function captureTabScreenshot(tab) {
  try {
    return await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: JA.CONFIG.visionJpegQuality || 60
    });
  } catch (e) {
    console.warn('captureVisibleTab failed:', e.message || e);
    return null;
  }
}
