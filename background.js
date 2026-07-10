/**
 * background.js — MV3 Service Worker
 *
 * Lightweight event hub:
 *  1. Opens the side panel when the extension icon is clicked.
 *  2. Sets a badge dot when the content script reports it's loaded on a LinkedIn page.
 *  3. Clears the badge when the user navigates away from LinkedIn.
 */

/* ---- Install / Update ---- */
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[LeadQualify] Extension installed — v2.0.0');
  } else if (details.reason === 'update') {
    console.log('[LeadQualify] Extension updated to', chrome.runtime.getManifest().version);
  }
});

/* ---- Open side panel on icon click ---- */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn('[LeadQualify] sidePanel setup:', err));

/* ---- Content-script ready signal ---- */
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'CONTENT_SCRIPT_LOADED' && sender.tab?.id) {
    chrome.action.setBadgeText({ text: '✓', tabId: sender.tab.id });
    chrome.action.setBadgeBackgroundColor({ color: '#6c5ce7', tabId: sender.tab.id });
  }
});

/* ---- Clear badge on navigation away from LinkedIn ---- */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && !changeInfo.url.includes('linkedin.com')) {
    chrome.action.setBadgeText({ text: '', tabId });
  }
});
