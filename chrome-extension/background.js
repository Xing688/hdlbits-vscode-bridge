// ── HDLBits VS Code Bridge — Service Worker ──────────────

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        console.log('[HDLBits Bridge] Extension installed');
    }
});
