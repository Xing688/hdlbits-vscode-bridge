// ── HDLBits VS Code Bridge — Content Script ──────────────
// Injects "Open in VS Code" button on HDLBits problem pages
// and communicates with the VS Code extension via local HTTP server.
//
// Server port — must match VS Code extension setting hdlbits.serverPort (default: 19876)
(function () {
    'use strict';

    const VSCODE_SERVER = 'http://127.0.0.1:19876';
    const POLL_INTERVAL = 2000;

    let _connected = false;
    let _problemId = null;
    let _pageName = null;
    let _moduleDecl = '';
    let _originalCode = ''; // Saved original code before Google Translate

    // ── Protect code from Google Translate ────────────────
    function protectFromTranslation() {
        // Only protect code-related elements themselves — do NOT walk up the DOM tree
        // (that would disable translation for the entire page)
        const ids = ['codesubmitbox', 'portlistbox', 'portlistouterbox', 'submitbox'];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.setAttribute('translate', 'no');
                el.classList.add('notranslate');
            }
        });

        // Protect all code/pre/textarea elements
        document.querySelectorAll('pre, textarea, code').forEach(el => {
            el.setAttribute('translate', 'no');
            el.classList.add('notranslate');
        });

        // CodeMirror DOM containers
        document.querySelectorAll('.CodeMirror').forEach(el => {
            el.setAttribute('translate', 'no');
            el.classList.add('notranslate');
            // CodeMirror inner line elements
            el.querySelectorAll('.CodeMirror-line, .CodeMirror-lines, .CodeMirror-code').forEach(c => {
                c.setAttribute('translate', 'no');
                c.classList.add('notranslate');
            });
        });
    }

    // ── Save original code before translation ─────────────
    function saveOriginalCode() {
        // Extract from hidden <pre> template (server-rendered, immune to translation)
        const portList = document.getElementById('portlistbox');
        if (portList) {
            const hiddenPre = portList.nextElementSibling;
            if (hiddenPre && hiddenPre.tagName === 'PRE' && hiddenPre.textContent.trim()) {
                const tmpl = portList.textContent.trim() + '\n' + hiddenPre.textContent.trim() + '\n\nendmodule\n';
                if (!/[一-鿿]/.test(tmpl)) {
                    _originalCode = tmpl;
                }
            }
        }
        // Fallback: textarea
        if (!_originalCode) {
            const codeBox = document.getElementById('codesubmitbox');
            if (codeBox && codeBox.value && !/[一-鿿]/.test(codeBox.value)) {
                _originalCode = codeBox.value;
            }
        }
    }

    // ── Fetch original HTML source (bypasses any JS/DOM modification) ─
    async function fetchOriginalSource() {
        try {
            const resp = await fetch(window.location.href);
            const html = await resp.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const portList = doc.getElementById('portlistbox');
            if (portList) {
                const hiddenPre = portList.nextElementSibling;
                if (hiddenPre && hiddenPre.tagName === 'PRE' && hiddenPre.textContent.trim()) {
                    const tmpl = portList.textContent.trim() + '\n' + hiddenPre.textContent.trim() + '\n\nendmodule\n';
                    if (!/[一-鿿]/.test(tmpl)) {
                        _originalCode = tmpl;
                        _moduleDecl = portList.textContent.trim();
                    }
                }
            }
        } catch (e) {
            console.warn('[HDLBits Bridge] fetch original source failed:', e.message);
        }
    }

    // ── Detect problem context ──────────────────────────
    function detectProblem() {
        const submitBox = document.getElementById('submitbox');
        if (!submitBox) return false;

        // Page name from MediaWiki or URL
        _pageName = (window.mw && mw.config.get('wgPageName')) ||
            window.location.pathname.replace('/wiki/', '').replace(/\//g, '');
        _problemId = _pageName.toLowerCase();

        // Module declaration from problem statement
        const portList = document.getElementById('portlistbox');
        if (portList) {
            _moduleDecl = portList.textContent.trim();
        }

        return true;
    }

    // ── Check VS Code connection ────────────────────────
    async function checkConnection() {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 1500);
            const resp = await fetch(VSCODE_SERVER + '/status', {
                signal: controller.signal,
                mode: 'cors'
            });
            clearTimeout(timeout);
            if (resp.ok) {
                _connected = true;
                return true;
            }
        } catch (e) {
            // Server not running or unreachable
        }
        _connected = false;
        return false;
    }

    // ── Poll for new submission → auto-refresh page ────────
    async function pollSubmitRefresh() {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 1500);
            const resp = await fetch(VSCODE_SERVER + '/last-submit', {
                signal: controller.signal,
                mode: 'cors'
            });
            clearTimeout(timeout);
            if (!resp.ok) return;

            const data = await resp.json();
            if (!data.time) return;

            // sessionStorage prevents duplicate refreshes (once per submission)
            const key = 'hdlbits_refreshed_for';
            const handled = sessionStorage.getItem(key);

            // New submission timestamp, within last 15 seconds (avoid stale triggers on page load)
            if (handled !== String(data.time) && Date.now() - data.time < 15000) {
                sessionStorage.setItem(key, String(data.time));
                // 1-second delay to let submission result settle
                setTimeout(() => {
                    window.location.reload();
                }, 1000);
            }
        } catch (e) {
            // Silent
        }
    }

    // ── Get clean code (CodeMirror first, textarea fallback) ─
    function getCleanCode() {
        let code = '';

        // 1. Try CodeMirror editor (HDLBits' actual editor)
        // HDLBits exposes global "editor", a CodeMirror instance with getValue()
        try {
            if (typeof editor !== 'undefined' && editor && typeof editor.getValue === 'function') {
                code = editor.getValue();
            }
        } catch(e) {}

        // 2. Try window.editor
        if (!code) {
            try {
                if (typeof window.editor !== 'undefined' && window.editor && typeof window.editor.getValue === 'function') {
                    code = window.editor.getValue();
                }
            } catch(e) {}
        }

        // 3. Fallback: read textarea directly
        if (!code) {
            const codeBox = document.getElementById('codesubmitbox');
            code = codeBox ? codeBox.value : '';
        }

        // 4. If code is empty or incomplete (missing body), fill from hidden <pre> template
        if (!code || code.trim().split('\n').length < 3) {
            const portList = document.getElementById('portlistbox');
            if (portList) {
                const hiddenPre = portList.nextElementSibling;
                if (hiddenPre && hiddenPre.tagName === 'PRE' && hiddenPre.textContent.trim()) {
                    const template = hiddenPre.textContent.trim();
                    code = portList.textContent.trim() + '\n' + template + '\n\nendmodule\n';
                }
            }
        }

        // 5. If code was corrupted by Google Translate → use cached original
        const hasChinese = /[一-鿿]/.test(code);
        if (hasChinese && _originalCode && !/[一-鿿]/.test(_originalCode)) {
            return _originalCode;
        }

        // 6. Cache clean code
        if (!hasChinese && code) {
            _originalCode = code;
        }

        return code;
    }

    // ── Get clean module declaration ──────────────────────
    function getCleanModuleDecl() {
        const portList = document.getElementById('portlistbox');
        if (!portList) return _moduleDecl || '';
        const text = portList.textContent.trim();
        // If translated, fall back to saved original
        if (/[一-鿿]/.test(text) && _moduleDecl && !/[一-鿿]/.test(_moduleDecl)) {
            return _moduleDecl;
        }
        if (!/[一-鿿]/.test(text)) {
            _moduleDecl = text;
        }
        return _moduleDecl;
    }

    // ── Send "Open in VS Code" request ──────────────────
    async function openInVSCode() {
        const btn = document.getElementById('vscode-open-btn');
        if (!btn) return;

        btn.textContent = '⏳ Opening...';
        btn.disabled = true;
        btn.style.opacity = '0.7';

        const rawCode = getCleanCode();
        const moduleDecl = getCleanModuleDecl();

        // Extract code body from the editor — strip module header line and endmodule,
        // keeping only the user-written code portion
        function extractBody(code) {
            let body = code;
            // Remove module declaration line
            body = body.replace(/^\s*module\s+\w+[^;]*;?\s*\n?/im, '');
            // Remove trailing endmodule
            body = body.replace(/\n?\s*endmodule\s*$/im, '');
            return body.trim();
        }

        const bodyCode = extractBody(rawCode);

        try {
            const resp = await fetch(VSCODE_SERVER + '/open', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    problemId: _problemId,
                    pageName: _pageName,
                    portDeclaration: moduleDecl,
                    bodyCode: bodyCode
                })
            });

            const result = await resp.json();
            if (result.success) {
                if (result.focused) {
                    btn.textContent = '✅ Opened in VS Code';
                    btn.style.background = '#4caf50';
                } else {
                    btn.textContent = '⚠️ File opened, window not focused';
                    btn.style.background = '#f0ad4e';
                }
                setTimeout(() => {
                    btn.textContent = '📝 Open in VS Code';
                    btn.style.background = '#007acc';
                    btn.disabled = false;
                    btn.style.opacity = '1';
                }, 2500);
            } else {
                throw new Error(result.error || 'Unknown error');
            }
        } catch (e) {
            console.error('[HDLBits Bridge]', e.message);
            btn.textContent = '❌ Not connected';
            btn.style.background = '#e74c3c';
            btn.disabled = false;
            btn.style.opacity = '1';
            setTimeout(() => {
                btn.textContent = '📝 Open in VS Code';
                btn.style.background = '#007acc';
            }, 2500);

            showToast('⚠️ VS Code is not running or HDLBits Connector extension is not installed');
        }
    }

    // ── UI: Toast notification ──────────────────────────
    function showToast(message) {
        let toast = document.getElementById('vscode-bridge-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'vscode-bridge-toast';
            toast.style.cssText = `
                position: fixed; bottom: 20px; right: 20px;
                background: #333; color: #fff; padding: 10px 18px;
                border-radius: 6px; font-size: 13px; z-index: 99999;
                box-shadow: 0 2px 12px rgba(0,0,0,0.3);
                max-width: 400px; transition: opacity 0.3s;
            `;
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.style.opacity = '1';
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => {
            toast.style.opacity = '0';
        }, 4000);
    }

    // ── UI: Create the VS Code button ───────────────────
    function createButton() {
        if (document.getElementById('vscode-open-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'vscode-open-btn';
        btn.type = 'button';
        btn.className = 'vscode-bridge-btn';
        btn.innerHTML = '📝 Open in VS Code';
        btn.title = 'Open this problem as a .v file in VS Code';
        btn.addEventListener('click', openInVSCode);

        return btn;
    }

    // ── UI: Create info banner ──────────────────────────
    function createBanner() {
        if (document.getElementById('vscode-bridge-banner')) return;

        const banner = document.createElement('div');
        banner.id = 'vscode-bridge-banner';
        banner.style.cssText = `
            background: linear-gradient(135deg, #007acc 0%, #005a9e 100%);
            color: #fff; padding: 6px 14px; border-radius: 4px;
            margin-bottom: 10px; font-size: 13px;
            display: flex; align-items: center; gap: 8px;
        `;
        banner.innerHTML = `
            <span style="font-size:16px;">🔌</span>
            <span style="flex:1;">
                <strong>VS Code Bridge</strong> — Write in VS Code, submit from VS Code
            </span>
        `;

        // Connection indicator
        const indicator = document.createElement('span');
        indicator.id = 'vscode-bridge-indicator';
        indicator.style.cssText = `
            font-size: 11px; opacity: 0.85;
            padding: 2px 8px; border-radius: 10px;
            background: rgba(255,255,255,0.2);
        `;
        indicator.textContent = 'Checking...';
        banner.appendChild(indicator);

        // Periodically check connection
        async function updateIndicator() {
            const connected = await checkConnection();
            const el = document.getElementById('vscode-bridge-indicator');
            if (el) {
                if (connected) {
                    el.textContent = '✅ Connected';
                    el.style.background = 'rgba(76,175,80,0.5)';
                } else {
                    el.textContent = '⚫ Disconnected';
                    el.style.background = 'rgba(255,255,255,0.15)';
                }
            }
        }

        updateIndicator();
        setInterval(updateIndicator, 5000);

        return banner;
    }

    // ── Inject UI elements ──────────────────────────────
    function injectUI() {
        const submitBox = document.getElementById('submitbox');
        if (!submitBox) return;

        // ── Banner above submit box ──
        const banner = createBanner();
        const firstChild = submitBox.firstElementChild;
        if (firstChild && !document.getElementById('vscode-bridge-banner')) {
            submitBox.insertBefore(banner, firstChild);
        }

        // ── Button next to Submit ──
        const submitBtn = document.getElementById('submitnewwindow');
        if (submitBtn && !document.getElementById('vscode-open-btn')) {
            const btn = createButton();
            submitBtn.parentNode.insertBefore(btn, submitBtn.nextSibling);

            // Add separator
            const sep = document.createElement('span');
            sep.style.cssText = 'margin: 0 6px; color: #999;';
            sep.textContent = '|';
            submitBtn.parentNode.insertBefore(sep, submitBtn.nextSibling);
        }

        // ── Hint below code editor ──
        const codeBox = document.getElementById('codesubmitbox');
        if (codeBox && !document.getElementById('vscode-hint')) {
            const hint = document.createElement('div');
            hint.id = 'vscode-hint';
            hint.className = 'notranslate';
            hint.setAttribute('translate', 'no');
            hint.style.cssText = `
                font-size: 11px; color: #999; margin-top: 4px;
                border-left: 3px solid #007acc; padding-left: 8px;
            `;
            hint.innerHTML = `
                💡 <strong>Workflow:</strong>
                Click <em>Open in VS Code</em> → Edit in VS Code →
                Save → Submit via VS Code status bar
            `;
            codeBox.parentNode.insertBefore(hint, codeBox.nextSibling);

            // Listen for code changes
            codeBox.addEventListener('input', () => {
                if (codeBox.value.trim() && codeBox.value.length > 50) {
                    hint.style.opacity = '0.4';
                }
                // Continuously cache untranslated code
                if (!/[一-鿿]/.test(codeBox.value)) {
                    _originalCode = codeBox.value;
                }
            });
        }
    }

    // ── Main ────────────────────────────────────────────
    function init() {
        if (!detectProblem()) return;

        // Immediately protect code areas from translation
        protectFromTranslation();
        saveOriginalCode();

        // Async fetch original HTML source (fallback if DOM was already translated)
        fetchOriginalSource();

        injectUI();

        // Poll VS Code submission status every 3s, auto-refresh on new submission
        pollSubmitRefresh();
        setInterval(pollSubmitRefresh, 3000);

        // Check for translation corruption every 2s
        setInterval(() => {
            protectFromTranslation();
        }, 2000);

        // Watch for dynamic DOM changes
        const observer = new MutationObserver(() => {
            protectFromTranslation();
            injectUI();
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // Stop observing after 15 seconds
        setTimeout(() => observer.disconnect(), 15000);
    }

    // ── Bootstrap: run as early as possible ──────────────
    // manifest "run_at": "document_start" → DOM not ready yet
    // Use DOMContentLoaded to execute before Google Translate (document_idle)
    function bootstrap() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                init();
                // Retry with delays in case async content arrives late
                [1500, 3000, 5000].forEach(delay => {
                    setTimeout(() => {
                        protectFromTranslation();
                        if (!document.getElementById('vscode-bridge-banner')) {
                            init();
                        }
                    }, delay);
                });
            });
        } else {
            // DOM already loaded (rare)
            init();
            [1500, 3000, 5000].forEach(delay => {
                setTimeout(() => {
                    protectFromTranslation();
                    if (!document.getElementById('vscode-bridge-banner')) {
                        init();
                    }
                }, delay);
            });
        }
    }

    bootstrap();
})();
