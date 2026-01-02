const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ==================== STATE ====================
let accountStatusBarItem = null;      // $(account) Account icon
let modelStatusBarItem = null;        // Model name (shows "Offline" in red when down)
let currentModel = 'unknown';
let isProxyOnline = false;
let pollInterval = null;
let currentIDEAccount = null;         // Current Antigravity IDE account info
let settingsWatcher = null;           // File watcher for Claude Code settings

// Configuration
const PROXY_POLL_INTERVAL_MS = 5000;
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// Available models for quick switching
const MODELS = [
    { label: '⚡ Flash', model: 'gemini-3-flash', description: 'Fast tasks' },
    { label: '💎 Pro', model: 'gemini-3-pro-high', description: 'Complex coding' },
    { label: '🎭 Opus', model: 'claude-opus-4-5-thinking', description: 'Deep reasoning' },
    { label: '🎵 Sonnet', model: 'claude-sonnet-4-5-thinking', description: 'Balanced' },
    { label: '🌐 Grok', model: 'pplx-grok', description: 'With web search' },
    { label: '🔍 Perplexity', model: 'sonar', description: 'Search focused' },
];

// ==================== ACTIVATION ====================

function activate(context) {
    console.log('[Claude Proxy] Extension v3.7.0 activated');

    // ==================== STATUS BAR ITEMS (2 icons only) ====================

    // 1. Account Status Bar (priority 101 - left)
    accountStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    accountStatusBarItem.text = '$(account)';
    accountStatusBarItem.command = 'antigravity.switchIDEAccount';
    accountStatusBarItem.show();
    context.subscriptions.push(accountStatusBarItem);

    // 2. Model Status Bar (priority 100 - right of account)
    modelStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    modelStatusBarItem.text = '$(sync~spin) ...';
    modelStatusBarItem.tooltip = 'Connecting to proxy...';
    modelStatusBarItem.command = 'antigravity.switchModel';
    modelStatusBarItem.show();
    context.subscriptions.push(modelStatusBarItem);

    // ==================== COMMANDS ====================

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.openDashboard', () => {
            vscode.env.openExternal(vscode.Uri.parse('http://localhost:8080/dashboard#overview'));
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.switchModel', async () => {
            const selected = await vscode.window.showQuickPick(MODELS, {
                placeHolder: `Current: ${getDisplayName(currentModel)}`,
                title: '🧠 Switch Model'
            });
            if (selected) {
                await setModelOnProxy(selected.model);
            }
        })
    );

    // IDE Account Switcher - Opens VS Code's native account manager
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.switchIDEAccount', async () => {
            try {
                await vscode.commands.executeCommand('workbench.action.accounts');
            } catch (e) {
                vscode.window.showInformationMessage(
                    'Click your profile icon (top-right) to switch accounts'
                );
            }
        })
    );

    // ==================== IDE ACCOUNT TRACKING ====================

    // Initial fetch of IDE account info
    updateIDEAccountInfo();

    // Listen for authentication changes
    context.subscriptions.push(
        vscode.authentication.onDidChangeSessions(() => {
            updateIDEAccountInfo();
        })
    );

    // ==================== POLLING ====================
    checkProxyHealth();
    pollInterval = setInterval(() => {
        checkProxyHealth();
        updateIDEAccountInfo(); // Also refresh account info
    }, PROXY_POLL_INTERVAL_MS);

    // ==================== WATCH CLAUDE CODE SETTINGS ====================
    // Instantly update status bar when user changes model in Claude Code UI
    watchClaudeSettings();

    // Also listen for VS Code configuration changes (claudeCode.selectedModel)
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('claudeCode.selectedModel')) {
                const config = vscode.workspace.getConfiguration('claudeCode');
                const newModel = config.get('selectedModel');
                if (newModel && newModel !== currentModel) {
                    console.log(`[Claude Proxy] VS Code config changed: claudeCode.selectedModel = ${newModel}`);
                    currentModel = newModel;
                    updateModelStatusBar();
                    setModelOnProxy(newModel);
                }
            }
        })
    );

    context.subscriptions.push({
        dispose: () => {
            if (pollInterval) clearInterval(pollInterval);
            if (settingsWatcher) settingsWatcher.close();
        }
    });
}

// ==================== IDE ACCOUNT FUNCTIONS ====================

async function updateIDEAccountInfo() {
    try {
        // Antigravity uses 'google' as the primary auth provider
        const providers = ['google', 'github', 'microsoft'];
        let allAccounts = [];
        let primaryAccount = null;

        for (const provider of providers) {
            try {
                // Use getSession with silent mode (how Antigravity works)
                const session = await vscode.authentication.getSession(provider, [], {
                    createIfNone: false,
                    silent: true
                });

                if (session) {
                    const accountInfo = {
                        provider: provider,
                        email: session.account.label,
                        id: session.account.id
                    };
                    allAccounts.push(accountInfo);

                    // First account found is the active one (Google preferred for Antigravity)
                    if (!primaryAccount) {
                        primaryAccount = accountInfo;
                    }
                }
            } catch (e) {
                // Provider not available or no session, continue
            }
        }

        if (primaryAccount) {
            currentIDEAccount = {
                ...primaryAccount,
                allAccounts: allAccounts
            };
        } else {
            currentIDEAccount = null;
        }

        // Update tooltip with current account info
        if (accountStatusBarItem) {
            accountStatusBarItem.tooltip = createAccountTooltip();
        }
    } catch (e) {
        console.log('[Claude Proxy] Could not fetch IDE account info:', e.message);
    }
}

// ==================== CLAUDE CODE SETTINGS WATCHER ====================

function watchClaudeSettings() {
    try {
        // Check if the settings file exists
        if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) {
            console.log('[Claude Proxy] Claude settings file not found, skipping watch');
            return;
        }

        // Watch for changes to Claude Code settings
        settingsWatcher = fs.watch(CLAUDE_SETTINGS_PATH, { persistent: false }, (eventType) => {
            if (eventType === 'change') {
                try {
                    const data = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
                    if (data.model && data.model !== currentModel) {
                        console.log(`[Claude Proxy] Detected model change in Claude settings: ${data.model}`);
                        currentModel = data.model;
                        updateModelStatusBar();

                        // Also sync to proxy so it knows about the change
                        setModelOnProxy(data.model);
                    }
                } catch (e) {
                    // File might be being written, ignore parse errors
                }
            }
        });

        console.log('[Claude Proxy] Watching Claude settings for instant model sync');
    } catch (e) {
        console.log('[Claude Proxy] Could not watch Claude settings:', e.message);
    }
}

// ==================== PROXY/MODEL FUNCTIONS ====================

function checkProxyHealth() {
    const req = http.request({
        hostname: 'localhost',
        port: 8080,
        path: '/active-model',
        method: 'GET',
        timeout: 2000
    }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                const json = JSON.parse(data);
                isProxyOnline = true;
                if (json.model && json.model !== currentModel) {
                    currentModel = json.model;
                }
                updateModelStatusBar();
            } catch (e) {
                isProxyOnline = false;
                updateModelStatusBar();
            }
        });
    });

    req.on('error', () => {
        isProxyOnline = false;
        updateModelStatusBar();
    });
    req.on('timeout', () => req.destroy());
    req.end();
}

function setModelOnProxy(model) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ model });
        const req = http.request({
            hostname: 'localhost',
            port: 8080,
            path: '/active-model',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 5000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    currentModel = model;
                    updateModelStatusBar();
                    vscode.window.showInformationMessage(`🧠 Model: ${getDisplayName(model)}`);
                    resolve();
                } else {
                    reject(new Error(data));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(postData);
        req.end();
    });
}

function updateModelStatusBar() {
    if (!modelStatusBarItem) return;

    if (!isProxyOnline) {
        // Show "Offline" in red when proxy is down
        modelStatusBarItem.text = '$(warning) Offline';
        modelStatusBarItem.tooltip = 'Proxy offline - click to retry';
        modelStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
        // Show model name when online
        modelStatusBarItem.text = getDisplayName(currentModel);
        modelStatusBarItem.tooltip = `Model: ${currentModel}\nClick to switch`;
        modelStatusBarItem.backgroundColor = undefined;
    }
}

function getDisplayName(model) {
    if (!model) return '❓';
    const m = model.toLowerCase();
    if (m.includes('flash')) return '⚡ Flash';
    if (m.includes('pro')) return '💎 Pro';
    if (m.includes('opus')) return '🎭 Opus';
    if (m.includes('sonnet')) return '🎵 Sonnet';
    if (m.includes('haiku')) return '📝 Haiku';
    if (m.includes('grok')) return '🌐 Grok';
    if (m.includes('pplx') || m.includes('sonar')) return '🔍 Perplexity';
    return model.length > 15 ? model.substring(0, 12) + '...' : model;
}

// ==================== TOOLTIPS ====================

function createAccountTooltip() {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    md.appendMarkdown(`### $(account) AntiGravity IDE Account\n\n`);

    if (currentIDEAccount) {
        // Show current/primary account
        const providerIcon = getProviderIcon(currentIDEAccount.provider);
        md.appendMarkdown(`**Active:** ${providerIcon} ${currentIDEAccount.email}\n\n`);

        // Show all logged-in accounts if multiple
        const allAccounts = currentIDEAccount.allAccounts || [];
        if (allAccounts.length > 1) {
            md.appendMarkdown(`**All accounts:**\n`);
            for (const acc of allAccounts) {
                const icon = getProviderIcon(acc.provider);
                md.appendMarkdown(`- ${icon} ${acc.email}\n`);
            }
            md.appendMarkdown(`\n`);
        }
    } else {
        md.appendMarkdown(`*No account signed in*\n\n`);
    }

    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`[$(account) Switch Account](command:antigravity.switchIDEAccount) · `);
    md.appendMarkdown(`[$(server) Proxy Dashboard](command:antigravity.openDashboard)`);
    return md;
}

function getProviderIcon(provider) {
    switch (provider) {
        case 'google': return '🔵';
        case 'github': return '⚫';
        case 'microsoft': return '🟦';
        default: return '👤';
    }
}

// ==================== DEACTIVATION ====================

function deactivate() {
    if (pollInterval) clearInterval(pollInterval);
    console.log('[Claude Proxy] Extension deactivated');
}

module.exports = { activate, deactivate };
