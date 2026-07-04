// background.js - opens the sidebar UI when the extension icon is clicked.

// Preferred: native side panel opens on action click (Chrome 116+).
// Guarded so the service worker still registers on browsers without the API.
try {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })?.catch(() => {});
} catch (e) {}

// Fallback: open the side panel explicitly, or the sidebar as a tab when the
// side panel API is unavailable (older Chrome, some Chromium forks).
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (e) {
    chrome.tabs.create({ url: chrome.runtime.getURL('sidebar.html') });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('Job Application Automator installed.');
});
