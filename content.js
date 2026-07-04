// content.js - Injected into webpage to extract context and provide control indicators

// Visual highlight overlay (Claude-style control border)
function showControlBorder() {
  let border = document.getElementById('agent-control-border');
  if (!border) {
    border = document.createElement('div');
    border.id = 'agent-control-border';
    border.style.position = 'fixed';
    border.style.top = '0';
    border.style.left = '0';
    border.style.width = '100vw';
    border.style.height = '100vh';
    border.style.border = '4px dashed #f97316'; // Orange dashed border
    border.style.boxSizing = 'border-box';
    border.style.pointerEvents = 'none'; // Ensure it doesn't block clicks
    border.style.zIndex = '2147483647'; // Max z-index
    border.style.transition = 'opacity 0.3s ease';
    document.body.appendChild(border);
  }
  border.style.opacity = '1';
}

function hideControlBorder() {
  const border = document.getElementById('agent-control-border');
  if (border) {
    border.style.opacity = '0';
    setTimeout(() => border.remove(), 300);
  }
  const cursor = document.getElementById('agent-virtual-cursor');
  if (cursor) {
    cursor.style.opacity = '0';
    setTimeout(() => cursor.remove(), 300);
  }
}

// Generate CSS selector helper (as fallback)
function getSelector(el) {
  if (el.id) return `#${el.id}`;
  if (el.name) return `[name="${el.name}"]`;
  const tag = el.tagName.toLowerCase();
  const cls = [...el.classList].slice(0, 2).join('.');
  return cls ? `${tag}.${cls}` : tag;
}

// Listen for messages from sidebar
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only respond to messages in the main frame to avoid iframe pollution/mismatches
  if (window !== window.top) {
    return;
  }

  if (msg.type === 'START_AGENT') {
    showControlBorder();
    sendResponse({ success: true });
  }

  if (msg.type === 'STOP_AGENT') {
    hideControlBorder();
    sendResponse({ success: true });
  }

  if (msg.type === 'GET_CONTEXT') {
    // Scan the DOM (including Shadow roots) for visible interactive elements
    const interactiveElements = queryAllInteractive(document);
    let elementList = [];
    let idCounter = 1;

    let stats = {
      totalFound: interactiveElements.length,
      displayNone: 0,
      visibilityHidden: 0,
      disabled: 0,
      zeroSize: 0,
      passed: 0
    };

    interactiveElements.forEach(el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      
      // Skip disabled or explicitly hidden elements
      if (style.display === 'none') {
        stats.displayNone++;
        return;
      }
      if (style.visibility === 'hidden') {
        stats.visibilityHidden++;
        return;
      }
      if (el.disabled) {
        stats.disabled++;
        return;
      }

      // Skip elements that have no dimensions, unless they are inputs (like custom checkboxes)
      const tagName = el.tagName.toLowerCase();
      if (tagName !== 'input' && rect.width === 0 && rect.height === 0) {
        stats.zeroSize++;
        return;
      }

      stats.passed++;
      // Set unique identifier attribute
      const agentId = `agent-${idCounter++}`;
      el.setAttribute('data-agent-id', agentId);

      let type = tagName;
      let label = '';

      if (tagName === 'input' || tagName === 'textarea') {
        let stateStr = '';
        if (tagName === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
          stateStr = el.checked ? ' (CHECKED)' : ' (UNCHECKED)';
        } else {
          if (el.value) {
            stateStr = ` (Value: "${el.value}")`;
          }
        }
        type = `${tagName} (${el.type || 'text'})${stateStr}`;
        if (el.id) {
          const lbl = document.querySelector(`label[for="${el.id}"]`);
          if (lbl) label = lbl.innerText.trim();
        }
        if (!label) label = el.placeholder || el.name || el.ariaLabel || '';
        
        // Provide parent element/card text snippet as context for checkbox inputs
        if (tagName === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
          const parentText = el.parentElement 
            ? el.parentElement.innerText.substring(0, 150).replace(/\s+/g, ' ').trim() 
            : '';
          label = label ? `${label} (Context: ${parentText})` : `Context: ${parentText}`;
        }
      } else if (tagName === 'a') {
        type = 'link';
        label = el.innerText.trim() || el.title || el.ariaLabel || el.href || '';
      } else {
        label = el.innerText.trim() || el.title || el.ariaLabel || '';
      }

      label = label.replace(/\s+/g, ' ').trim();

      // Only include elements that are meaningful
      if (label || tagName === 'input' || tagName === 'select' || tagName === 'textarea') {
        elementList.push({
          id: agentId,
          type: type.toUpperCase(),
          label: label.substring(0, 140),
          selector: `[data-agent-id='${agentId}']`
        });
      }
    });

    // Format element list for the LLM
    const elementsText = elementList.map(e => 
      `[${e.id}] ${e.type} element labeled "${e.label}" -> CSS selector: ${e.selector}`
    ).slice(0, 80).join('\n');

    // Scan for drawer/modal structure
    const drawerInfo = detectDrawerStructure();
    let pageStateText = '';
    if (drawerInfo) {
      pageStateText += `\n[Active Overlay/Modal/Drawer Detected]\n`;
      pageStateText += `- Container: ${drawerInfo.selector}\n`;
      if (drawerInfo.structure.headerText) {
        pageStateText += `- Header/Title: "${drawerInfo.structure.headerText}"\n`;
      }
      if (drawerInfo.structure.closeButton) {
        let closeEl = drawerInfo.structure.closeButton;
        let agentId = null;
        for (let i = 0; i < 5 && closeEl; i++) {
          if (closeEl.getAttribute('data-agent-id')) {
            agentId = closeEl.getAttribute('data-agent-id');
            break;
          }
          closeEl = closeEl.parentElement;
        }
        if (agentId) {
          pageStateText += `- Close/Dismiss Button Reference: [${agentId}]\n`;
        }
      }
    }

    sendResponse({
      title: document.title,
      url: location.href,
      elements: elementsText,
      stats: stats,
      elementsCount: elementList.length,
      bodyText: document.body.innerText.substring(0, 3000),
      overlayInfo: pageStateText
    });
  }

  return true;
});

function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return el.offsetParent !== null && 
         style.visibility !== 'hidden' &&
         style.display !== 'none' &&
         rect.width > 0 &&
         rect.height > 0;
}

function detectDrawerStructure() {
  const patterns = [
    '.nI-gNb-drawer',
    '.naukri-drawer',
    '[class*="drawer"]',
    '[class*="sidebar"]',
    '[role="dialog"]',
    '[class*="panel"]',
    '.modal, .modal-content',
    '[class*="modal"]'
  ];
  
  for (let selector of patterns) {
    try {
      const drawer = document.querySelector(selector);
      if (drawer && isElementVisible(drawer)) {
        const overlay = document.querySelector('[class*="overlay"], [class*="backdrop"]');
        const closeButton = drawer.querySelector('[class*="close"], [aria-label*="close"], [id*="close"], .cross');
        const header = drawer.querySelector('[class*="header"], h1, h2, h3, [id*="title"]');
        
        return {
          element: drawer,
          selector: selector,
          structure: {
            overlay: overlay,
            closeButton: closeButton,
            headerText: header ? header.textContent.trim() : ''
          }
        };
      }
    } catch(e) {}
  }
  return null;
}

function queryAllInteractive(root = document) {
  let elements = [];
  const seen = new Set();

  function addUnique(nodeList) {
    nodeList.forEach(el => { if (!seen.has(el)) { seen.add(el); elements.push(el); } });
  }

  try {
    // Standard interactive elements + tabindex + ARIA roles
    const found = root.querySelectorAll(
      'a, button, input, textarea, select, ' +
      '[role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], ' +
      '[role="treeitem"], [role="gridcell"], [role="row"], ' +
      '[onclick], [tabindex="0"]'
    );
    addUnique(found);
  } catch(e) {}

  // Detect clickable divs/li/article elements by cursor:pointer style
  // Limited to children of common list/feed containers to avoid scanning everything
  try {
    const containers = root.querySelectorAll(
      'ul, ol, [role="list"], [role="feed"], [role="listbox"], ' +
      '[role="main"], [role="grid"], [role="tree"], ' +
      '[class*="list"], [class*="feed"], [class*="results"], [class*="cards"]'
    );
    containers.forEach(container => {
      Array.from(container.children).forEach(child => {
        if (seen.has(child)) return;
        const tag = child.tagName.toLowerCase();
        if (['li', 'div', 'article', 'section'].includes(tag)) {
          const style = window.getComputedStyle(child);
          if (style.cursor === 'pointer') {
            seen.add(child);
            elements.push(child);
          }
        }
      });
    });
  } catch(e) {}

  // Shadow DOM traversal
  try {
    const all = root.querySelectorAll('*');
    all.forEach(el => {
      if (el.shadowRoot) {
        elements.push(...queryAllInteractive(el.shadowRoot));
      }
    });
  } catch(e) {}

  return elements;
}
