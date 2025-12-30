const vscode = require('vscode');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let proxyProcess = null;

function activate(context) {
    console.log('Claude Proxy Status active');

    // Auto-start proxy if in workspace
    tryStartProxy();

    let currentPanel = undefined;

    // Command to open the dashboard
    let disposable = vscode.commands.registerCommand('claude-proxy.openDashboard', function () {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (currentPanel) {
            currentPanel.reveal(column);
            updateContent(currentPanel);
            return;
        }

        currentPanel = vscode.window.createWebviewPanel(
            'claudeProxyDashboard',
            'Claude Proxy Dashboard',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: []
            }
        );

        updateContent(currentPanel);

        // Listen for messages from webview (e.g. Retry button)
        currentPanel.webview.onDidReceiveMessage(
            message => {
                if (message.command === 'retry') {
                    tryStartProxy(); // Try starting again just in case
                    setTimeout(() => updateContent(currentPanel), 1000);
                }
            },
            undefined,
            context.subscriptions
        );

        currentPanel.onDidDispose(
            () => { currentPanel = undefined; },
            null,
            context.subscriptions
        );
    });
    context.subscriptions.push(disposable);

    // Create Status Bar Item
    const myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    myStatusBarItem.text = "$(server) Claude Proxy";
    myStatusBarItem.tooltip = "Click to open Proxy Dashboard";
    myStatusBarItem.command = "claude-proxy.openDashboard";
    myStatusBarItem.show();
    context.subscriptions.push(myStatusBarItem);
}

function tryStartProxy() {
    // Check if checking limits works (proxy running)
    const req = http.get('http://localhost:8080/health', (res) => {
        // Running fine
        console.log('Proxy already running');
    });

    req.on('error', () => {
        // Not running, let's start it
        console.log('Proxy not running, attempting to start...');
        startProxyProcess();
    });
}

function startProxyProcess() {
    if (proxyProcess) return; // Already started by us

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;

    // Look for the proxy folder
    for (const folder of workspaceFolders) {
        const proxyPath = path.join(folder.uri.fsPath, 'antigravity-claude-proxy-main');
        if (fs.existsSync(path.join(proxyPath, 'package.json'))) {
            // Found it! Start node src/index.js
            const bgCmd = spawn('node', ['src/index.js'], {
                cwd: proxyPath,
                detached: false,
                shell: true
            });

            bgCmd.stdout.on('data', (data) => console.log(`Proxy: ${data}`));
            bgCmd.stderr.on('data', (data) => console.error(`Proxy Error: ${data}`));

            proxyProcess = bgCmd;
            vscode.window.showInformationMessage('Starting Antigravity Claude Proxy...');
            return;
        }
    }
}

function updateContent(panel) {
    if (!panel) return;
    panel.webview.html = getLoadingContent();
    http.get('http://localhost:8080/dashboard', (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => panel.webview.html = data);
    }).on('error', (err) => {
        panel.webview.html = getErrorContent(err.message);
    });
}

function getLoadingContent() {
    return `<!DOCTYPE html><html><body style="background:#0f1117;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;"><h3>Connecting to Proxy...</h3></body></html>`;
}

function getErrorContent(msg) {
    return `<!DOCTYPE html>
    <html><body style="background:#0f1117;color:#ef4444;padding:2rem;font-family:sans-serif;text-align:center;">
    <h2>Connection Failed</h2>
    <p>Could not connect to proxy at localhost:8080.</p>
    <p>Error: ${msg}</p>
    <button onclick="vscode.postMessage({command:'retry'})" style="background:#3b82f6;color:white;border:none;padding:10px 20px;border-radius:5px;cursor:pointer;margin-top:10px;">Start Proxy & Retry</button>
    <script>const vscode = acquireVsCodeApi();</script>
    </body></html>`;
}

function deactivate() {
    if (proxyProcess) {
        proxyProcess.kill();
    }
}

module.exports = { activate, deactivate };
