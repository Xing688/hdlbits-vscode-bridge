const vscode = require('vscode');
const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── State ────────────────────────────────────────────────
let server = null;
let statusBarItem = null;
let outputChannel = null;
let lastSubmitTime = 0;  // Timestamp of most recent completed submission

// ── Local HTTP Server ────────────────────────────────────
// Receives messages from the Chrome extension
function startServer(port) {
    if (server) {
        server.close();
    }

    server = http.createServer((req, res) => {
        // CORS for Chrome extension
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        // ── GET /status ── health check for Chrome extension
        if (req.method === 'GET' && req.url === '/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'connected',
                version: '1.0.0',
                workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null,
                lastSubmit: lastSubmitTime
            }));
            return;
        }

        // ── GET /last-submit ── Chrome extension polls for auto-refresh
        if (req.method === 'GET' && req.url === '/last-submit') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ time: lastSubmitTime }));
            return;
        }

        // ── POST /open ── Chrome extension asks to open a problem
        if (req.method === 'POST' && req.url === '/open') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    const result = await handleOpenProblem(data);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
            return;
        }

        // ── POST /submit ── Chrome extension asks to submit code
        if (req.method === 'POST' && req.url === '/submit') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    const result = handleSubmit(data);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
            return;
        }

        res.writeHead(404);
        res.end('Not found');
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            outputChannel.appendLine(`[HDLBits] Port ${port} is in use. Server may already be running.`);
        } else {
            outputChannel.appendLine(`[HDLBits] Server error: ${err.message}`);
        }
    });

    server.listen(port, '127.0.0.1', () => {
        outputChannel.appendLine(`[HDLBits] Bridge server listening on http://127.0.0.1:${port}`);
    });
}

// ── Handle "Open in VS Code" from Chrome ─────────────────
async function handleOpenProblem(data) {
    const config = vscode.workspace.getConfiguration('hdlbits');
    const problemId = data.problemId || data.pageName?.toLowerCase() || 'problem';
    const portDeclaration = data.portDeclaration || '';
    // bodyCode = user code extracted from the HDLBits editor (stripped of module header + endmodule)
    const bodyCode = data.bodyCode || data.existingCode || '';

    // Determine workspace directory
    let workspacePath = config.get('workspacePath') ||
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
        path.join(require('os').homedir(), 'hdlbits');

    if (!fs.existsSync(workspacePath)) {
        fs.mkdirSync(workspacePath, { recursive: true });
    }

    // Sanitize filename
    const safeName = problemId.replace(/[<>:"/\\|?*]/g, '_');
    const fileName = `${safeName}.v`;
    const filePath = path.join(workspacePath, fileName);

    // Build file content: compiler directives + module declaration + body code + endmodule
    // Extract compiler directives from portDeclaration (e.g. `default_nettype none)
    // to avoid duplication with bodyCode (extractBody can leave leftover directives)
    const directiveRegex = /^`[^\n]*\n/gm;
    let compilerDirectives = '';
    let cleanPortDecl = portDeclaration;

    const directiveMatch = portDeclaration.match(directiveRegex);
    if (directiveMatch) {
        compilerDirectives = directiveMatch.join('');
        cleanPortDecl = portDeclaration.replace(directiveRegex, '').trim();
    }

    // Strip compiler directives from bodyCode (they already go above module declaration)
    let cleanBody = bodyCode ? bodyCode.replace(directiveRegex, '').trim() : '';

    let content = `// hdlbits: ${problemId}\n`;
    if (compilerDirectives) {
        content += compilerDirectives;
    }
    content += `${cleanPortDecl}\n\n`;

    if (cleanBody) {
        content += cleanBody + '\n';
    } else {
        content += '    // Write your solution here\n';
    }
    content += '\nendmodule\n';

    // Write file
    fs.writeFileSync(filePath, content, 'utf-8');

    // Open in editor
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);

    // Try to bring VS Code window to front
    const focused = await focusVSCodeWindow();

    const msg = focused
        ? `[HDLBits] Opened + focused: ${problemId} → ${filePath}`
        : `[HDLBits] Opened (focus failed): ${problemId} → ${filePath}`;
    outputChannel.appendLine(msg);

    return { success: true, file: filePath, problemId: problemId, focused: focused };
}

// ── Bring VS Code window to front ──────────────────────
// Uses Win32 SetForegroundWindow + AttachThreadInput + topmost toggle
// More reliable than WScript.Shell.AppActivate
function focusVSCodeWindow() {
    return new Promise((resolve) => {
        // Delay 300ms to let VS Code finish opening the file
        setTimeout(() => {
            try {
                if (process.platform === 'win32') {
                    // Get current workspace name for accurate window matching
                    const wsName = vscode.workspace.workspaceFolders?.[0]?.name || '';

                    const psScript = [
                        'Add-Type -TypeDefinition @\'',
                        'using System;',
                        'using System.Runtime.InteropServices;',
                        'public class W32F {',
                        '    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);',
                        '    public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);',
                        '    public const int SW_RESTORE = 9;',
                        '    public const uint SWP_NOSIZE = 0x0001;',
                        '    public const uint SWP_NOMOVE = 0x0002;',
                        '    [DllImport("user32.dll")]',
                        '    public static extern bool SetForegroundWindow(IntPtr hWnd);',
                        '    [DllImport("user32.dll")]',
                        '    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
                        '    [DllImport("user32.dll")]',
                        '    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);',
                        '    [DllImport("user32.dll")]',
                        '    public static extern IntPtr GetForegroundWindow();',
                        '    [DllImport("user32.dll")]',
                        '    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);',
                        '    [DllImport("kernel32.dll")]',
                        '    public static extern uint GetCurrentThreadId();',
                        '    [DllImport("user32.dll")]',
                        '    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);',
                        '}',
                        '\'@',
                        '',
                        // Match window by workspace name first, fall back to any Code window
                        '$wsName = \'' + wsName.replace(/'/g, '\'\'') + '\'',
                        'if ($wsName) { $p = Get-Process -Name code -EA 0 | Where-Object {$_.MainWindowTitle -match [regex]::Escape($wsName)} | Select-Object -First 1 }',
                        'if (-not $p) { $p = Get-Process -Name code -EA 0 | Where-Object {$_.MainWindowTitle} | Select-Object -First 1 }',
                        'if (-not $p) { Write-Output "NO_WINDOW"; exit 1 }',
                        'if (-not $p.MainWindowHandle) { Write-Output "NO_HANDLE"; exit 2 }',
                        '$h = $p.MainWindowHandle',
                        'Write-Output ("TITLE:" + $p.MainWindowTitle)',
                        // AttachThreadInput to bypass foreground focus restriction
                        '$fg = [W32F]::GetForegroundWindow()',
                        '$tidFg = 0; [W32F]::GetWindowThreadProcessId($fg, [ref]$tidFg) | Out-Null',
                        '$tidCur = [W32F]::GetCurrentThreadId()',
                        '$attached = $false',
                        'if ($tidFg -gt 0 -and $tidFg -ne $tidCur) { $attached = [W32F]::AttachThreadInput($tidCur, $tidFg, $true) }',
                        // Restore minimized window → temporary topmost → remove topmost → activate
                        '[W32F]::ShowWindow($h, [W32F]::SW_RESTORE) | Out-Null',
                        '[W32F]::SetWindowPos($h, [W32F]::HWND_TOPMOST, 0, 0, 0, 0, [W32F]::SWP_NOSIZE -bor [W32F]::SWP_NOMOVE) | Out-Null',
                        '[W32F]::SetWindowPos($h, [W32F]::HWND_NOTOPMOST, 0, 0, 0, 0, [W32F]::SWP_NOSIZE -bor [W32F]::SWP_NOMOVE) | Out-Null',
                        '$result = [W32F]::SetForegroundWindow($h)',
                        'if ($attached) { [W32F]::AttachThreadInput($tidCur, $tidFg, $false) | Out-Null }',
                        'Write-Output ("FOCUS:" + $result)'
                    ].join('\n');

                    const os = require('os');
                    const tmpFile = path.join(os.tmpdir(), `hdlbits_focus_${Date.now()}.ps1`);
                    fs.writeFileSync(tmpFile, psScript, 'utf-8');

                    exec(
                        `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`,
                        { timeout: 8000 },
                        (error, stdout, stderr) => {
                            // Clean up temp file
                            try { fs.unlinkSync(tmpFile); } catch (_) {}

                            if (error) {
                                outputChannel.appendLine(`[HDLBits] focus error: ${error.message}`);
                                resolve(false);
                            } else {
                                if (stderr) outputChannel.appendLine(`[HDLBits] focus stderr: ${stderr.trim()}`);
                                if (stdout) outputChannel.appendLine(`[HDLBits] focus: ${stdout.trim()}`);
                                resolve(true);
                            }
                        }
                    );
                } else if (process.platform === 'darwin') {
                    exec(
                        "osascript -e 'tell application \"Visual Studio Code\" to activate'",
                        { timeout: 5000 },
                        (error, stdout, stderr) => {
                            if (error) {
                                outputChannel.appendLine(`[HDLBits] focus error: ${error.message}`);
                                resolve(false);
                            } else {
                                resolve(true);
                            }
                        }
                    );
                } else {
                    exec(
                        'xdotool search --class "code" windowactivate 2>/dev/null || wmctrl -a "Visual Studio Code" 2>/dev/null',
                        { timeout: 5000 },
                        (error, stdout, stderr) => {
                            if (error) {
                                outputChannel.appendLine(`[HDLBits] focus error: ${error.message}`);
                                resolve(false);
                            } else {
                                resolve(true);
                            }
                        }
                    );
                }
            } catch (e) {
                outputChannel.appendLine(`[HDLBits] focus exception: ${e.message}`);
                resolve(false);
            }
        }, 300);
    });
}

// ── Handle submit request ────────────────────────────────
function handleSubmit(data) {
    const submitExe = vscode.workspace.getConfiguration('hdlbits').get('submitScript') ||
        'hdlbits_submit';

    const filePath = data.filePath;
    const problemId = data.problemId || '';

    if (!filePath || !fs.existsSync(filePath)) {
        return { success: false, error: 'File not found: ' + filePath };
    }

    outputChannel.appendLine(`[HDLBits] Submitting: ${filePath}`);

    // Run submit tool
    exec(`"${submitExe}" "${filePath}" ${problemId ? `--id ${problemId}` : ''}`,
        { timeout: 30000 },
        (error, stdout, stderr) => {
            if (error) {
                outputChannel.appendLine(`[HDLBits] Submit error: ${error.message}`);
            }
            if (stdout) {
                outputChannel.appendLine(stdout);
            }
            if (stderr) {
                outputChannel.appendLine(stderr);
            }
        }
    );

    return { success: true, message: 'Submitting... Check terminal for results.' };
}

// ── Commands ─────────────────────────────────────────────

async function cmdSubmit() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('HDLBits: No active editor');
        return;
    }

    const filePath = editor.document.uri.fsPath;
    if (!filePath.endsWith('.v')) {
        vscode.window.showWarningMessage('HDLBits: Current file is not a Verilog (.v) file');
        return;
    }

    // Save before submit
    await editor.document.save();

    const config = vscode.workspace.getConfiguration('hdlbits');
    const submitExe = config.get('submitScript') || 'hdlbits_submit';

    // Reuse existing terminal instead of creating new ones
    let terminal = vscode.window.terminals.find(t => t.name === 'HDLBits Submit');
    if (!terminal) {
        terminal = vscode.window.createTerminal('HDLBits Submit');
    }
    terminal.show();
    terminal.sendText(`& "${submitExe}" "${filePath}"`);

    // Status bar progress indicator
    statusBarItem.text = '$(sync~spin) HDLBits: Submitting...';

    outputChannel.appendLine(`[HDLBits] Submitting: ${filePath}`);

    // Use exec to wait for actual completion before updating timestamp (triggers Chrome refresh)
    exec(`"${submitExe}" "${filePath}"`, { timeout: 60000 }, (error, stdout, stderr) => {
        statusBarItem.text = '$(cloud-upload) HDLBits';

        if (stdout) outputChannel.appendLine(stdout.trim());
        if (stderr) outputChannel.appendLine(stderr.trim());
        if (error) outputChannel.appendLine(`[HDLBits] Exit: ${error.message}`);

        // Only set timestamp after submission actually completes → Chrome refreshes when results are ready
        lastSubmitTime = Date.now();
        outputChannel.appendLine(`[HDLBits] Done → page will auto-refresh`);
    });
}

async function cmdNewProblem() {
    const config = vscode.workspace.getConfiguration('hdlbits');
    let workspacePath = config.get('workspacePath') ||
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (!workspacePath) {
        workspacePath = path.join(require('os').homedir(), 'hdlbits');
        vscode.window.showInformationMessage(
            `HDLBits: No workspace folder found. Will create files in: ${workspacePath}`
        );
    }

    // Ask for problem ID
    const problemId = await vscode.window.showInputBox({
        prompt: 'Enter HDLBits problem ID',
        placeHolder: 'e.g., step_one, vector0, fsm1',
        validateInput: (value) => {
            if (!value || value.trim().length === 0) return 'Problem ID is required';
            return null;
        }
    });

    if (!problemId) return;

    if (!fs.existsSync(workspacePath)) {
        fs.mkdirSync(workspacePath, { recursive: true });
    }

    const safeName = problemId.replace(/[<>:"/\\|?*]/g, '_');
    const filePath = path.join(workspacePath, `${safeName}.v`);
    const content = `// hdlbits: ${problemId}\n\nmodule top_module (\n    // TODO: add ports here\n);\n\n    // Write your solution here\n\nendmodule\n`;

    fs.writeFileSync(filePath, content, 'utf-8');

    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);

    outputChannel.appendLine(`[HDLBits] Created: ${filePath}`);
}

// ── Activation / Deactivation ────────────────────────────

function activate(context) {
    // Output channel
    outputChannel = vscode.window.createOutputChannel('HDLBits Connector');
    outputChannel.appendLine('[HDLBits] Extension activated');

    // Read config
    const config = vscode.workspace.getConfiguration('hdlbits');
    const port = config.get('serverPort') || 19876;

    // Start bridge server
    startServer(port);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('hdlbits.submit', cmdSubmit),
        vscode.commands.registerCommand('hdlbits.newProblem', cmdNewProblem)
    );

    // Status bar button
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right, 100
    );
    statusBarItem.command = 'hdlbits.submit';
    statusBarItem.text = '$(cloud-upload) HDLBits';
    statusBarItem.tooltip = 'Submit current Verilog file to HDLBits';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Listen for active editor changes to show/hide status bar
    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor && editor.document.fileName.endsWith('.v')) {
            statusBarItem.show();
        } else {
            statusBarItem.hide();
        }
    });

    outputChannel.appendLine('[HDLBits] Ready. Use Ctrl+Shift+P → HDLBits: Submit');
}

function deactivate() {
    if (server) {
        server.close();
    }
    if (outputChannel) {
        outputChannel.appendLine('[HDLBits] Extension deactivated');
    }
}

module.exports = { activate, deactivate };
