const vscode = require('vscode');
const http = require('http');
const https = require('https');
const url = require('url');

// ==================== STATE ====================
let modelStatusBarItem = null;
let accountStatusBarItem = null;
let currentModel = 'unknown';
let isProxyOnline = false;
let pollInterval = null;
let accountPollInterval = null;
let cachedSessions = [];
let cachedQuotas = {};
let extensionContext = null;

// Configuration
const PROXY_POLL_INTERVAL_MS = 5000; // 5 seconds
const ACCOUNT_POLL_INTERVAL_MS = 60000; // 1 minute

// Google API for quota fetching
const CLOUDCODE_API = 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels';

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
    console.log('[Claude Proxy] Extension activated');
    extensionContext = context;

    // ==================== STATUS BAR ITEMS ====================

    // Account Status Bar (priority 101 - leftmost)  
    accountStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    accountStatusBarItem.text = '👤';
    accountStatusBarItem.tooltip = 'Loading accounts...';
    accountStatusBarItem.command = 'antigravity.switchAccount';
    accountStatusBarItem.show();
    context.subscriptions.push(accountStatusBarItem);

    // Model Status Bar (priority 100)
    modelStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    modelStatusBarItem.text = '$(sync~spin) ...';
    modelStatusBarItem.tooltip = 'Connecting to proxy...';
    modelStatusBarItem.command = 'antigravity.switchModel';
    modelStatusBarItem.show();
    context.subscriptions.push(modelStatusBarItem);

    // ==================== COMMANDS ====================

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.openDashboard', () => {
            vscode.env.openExternal(vscode.Uri.parse('http://localhost:8080/dashboard'));
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

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.switchAccount', showAccountPicker)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.refreshAccounts', async () => {
            await refreshSessions();
            vscode.window.showInformationMessage('Accounts refreshed');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.addAccount', () => signInWithProvider('google'))
    );

    // ==================== AUTH SESSION LISTENER ====================
    vscode.authentication.onDidChangeSessions(async (e) => {
        console.log('[Claude Proxy] Auth sessions changed:', e.provider.id);
        await refreshSessions();
    });

    // ==================== INITIAL FETCH & POLLING ====================
    checkProxyHealth();
    refreshSessions();

    pollInterval = setInterval(checkProxyHealth, PROXY_POLL_INTERVAL_MS);
    accountPollInterval = setInterval(refreshSessions, ACCOUNT_POLL_INTERVAL_MS);

    context.subscriptions.push({
        dispose: () => {
            if (pollInterval) clearInterval(pollInterval);
            if (accountPollInterval) clearInterval(accountPollInterval);
        }
    });
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
            path: '/set-model',
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
        modelStatusBarItem.text = '$(warning) Offline';
        modelStatusBarItem.tooltip = 'Proxy offline - click to retry';
        modelStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
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

// ==================== ACCOUNT FUNCTIONS ====================

async function refreshSessions() {
    try {
        cachedSessions = [];

        // Try Google provider (standard VS Code auth)
        try {
            const session = await vscode.authentication.getSession('google', [], {
                createIfNone: false,
                silent: true
            });

            if (session) {
                // Fetch quotas for this account
                const quotas = await fetchQuotasForSession(session);
                cachedSessions.push({
                    provider: 'google',
                    account: session.account,
                    id: session.id,
                    accessToken: session.accessToken,
                    quotas: quotas,
                    isActive: true
                });
            }
        } catch (e) {
            console.log('[Claude Proxy] No Google session:', e.message);
        }

        updateAccountStatusBar();
    } catch (error) {
        console.error('[Claude Proxy] Error refreshing sessions:', error);
    }
}

async function fetchQuotasForSession(session) {
    if (!session.accessToken) return {};

    return new Promise((resolve) => {
        const urlParsed = url.parse(CLOUDCODE_API);
        const req = https.request({
            hostname: urlParsed.hostname,
            path: urlParsed.path,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${session.accessToken}`,
                'Content-Type': 'application/json',
                'User-Agent': 'antigravity/1.11.5 vscode-extension',
                'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1'
            },
            timeout: 10000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.models) {
                        const quotas = {};
                        for (const [modelId, modelData] of Object.entries(json.models)) {
                            if (modelData.quotaInfo) {
                                quotas[modelId] = {
                                    remaining: modelData.quotaInfo.remainingFraction ?? null,
                                    resetTime: modelData.quotaInfo.resetTime ?? null
                                };
                            }
                        }
                        resolve(quotas);
                    } else {
                        resolve({});
                    }
                } catch (e) {
                    resolve({});
                }
            });
        });

        req.on('error', () => resolve({}));
        req.on('timeout', () => { req.destroy(); resolve({}); });
        req.write('{}');
        req.end();
    });
}

function updateAccountStatusBar() {
    if (!accountStatusBarItem) return;

    if (cachedSessions.length === 0) {
        accountStatusBarItem.text = '👤+';
        accountStatusBarItem.tooltip = createNoAccountsTooltip();
        accountStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        accountStatusBarItem.text = '👤';
        accountStatusBarItem.tooltip = createAccountsTooltip();
        accountStatusBarItem.backgroundColor = undefined;
    }
}

function createNoAccountsTooltip() {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`### 👤 No Accounts\n\n`);
    md.appendMarkdown(`Sign in to use Antigravity\n\n`);
    md.appendMarkdown(`[🔵 Sign In with Google](command:antigravity.addAccount)`);
    return md;
}

function createAccountsTooltip() {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = true;

    md.appendMarkdown(`### 👤 Antigravity Accounts (${cachedSessions.length})\n\n`);

    for (const session of cachedSessions) {
        const icon = session.isActive ? '🟢' : '⚪';
        const email = session.account?.label || 'Unknown';
        const status = session.isActive ? '**Active**' : '';

        md.appendMarkdown(`${icon} **${email}** ${status}\n\n`);

        // Show quota info if available
        if (session.quotas && Object.keys(session.quotas).length > 0) {
            const modelsToShow = ['gemini-3-flash', 'gemini-3-pro', 'claude-sonnet-4-5', 'claude-opus-4-5'];
            for (const modelHint of modelsToShow) {
                const key = Object.keys(session.quotas).find(k => k.includes(modelHint));
                if (key) {
                    const q = session.quotas[key];
                    const pct = q.remaining !== null ? Math.round(q.remaining * 100) : '?';
                    const modelIcon = getModelIcon(key);
                    const resetInfo = q.resetTime ? formatResetTime(q.resetTime) : '';
                    md.appendMarkdown(`&nbsp;&nbsp;${modelIcon} ${pct}% ${resetInfo}\n`);
                }
            }
            md.appendMarkdown(`\n`);
        }

        md.appendMarkdown(`---\n\n`);
    }

    // Actions
    md.appendMarkdown(`[🔄 Switch](command:antigravity.switchAccount) · `);
    md.appendMarkdown(`[➕ Add](command:antigravity.addAccount) · `);
    md.appendMarkdown(`[📊 Dashboard](command:antigravity.openDashboard) · `);
    md.appendMarkdown(`[⚡ Refresh](command:antigravity.refreshAccounts)`);

    return md;
}

function getModelIcon(modelId) {
    if (!modelId) return '🔘';
    const m = modelId.toLowerCase();
    if (m.includes('flash')) return '⚡';
    if (m.includes('pro')) return '💎';
    if (m.includes('opus')) return '🎭';
    if (m.includes('sonnet')) return '🎵';
    return '🤖';
}

function formatResetTime(isoTime) {
    if (!isoTime) return '';
    try {
        const reset = new Date(isoTime);
        const now = new Date();
        const diff = reset - now;
        if (diff <= 0) return '(reset)';
        const hours = Math.floor(diff / 3600000);
        const mins = Math.floor((diff % 3600000) / 60000);
        if (hours > 0) return `(${hours}h ${mins}m)`;
        return `(${mins}m)`;
    } catch (e) {
        return '';
    }
}

async function showAccountPicker() {
    const items = [];

    // List existing accounts
    for (const session of cachedSessions) {
        items.push({
            label: `${session.isActive ? '🟢' : '⚪'} ${session.account?.label || 'Unknown'}`,
            description: session.isActive ? 'Currently Active' : 'Click to activate',
            detail: session.provider === 'google' ? 'Google Account' : session.provider,
            id: 'switch',
            session: session
        });
    }

    if (items.length > 0) {
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }

    // Add account options
    items.push({
        label: '🔵 Sign in with Google',
        description: 'Add a new Google account',
        id: 'add-google'
    });

    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

    items.push({
        label: '$(dashboard) Open Proxy Dashboard',
        description: 'Manage proxy accounts and settings',
        id: 'dashboard'
    });

    items.push({
        label: '$(refresh) Refresh',
        id: 'refresh'
    });

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Manage Antigravity Accounts',
        title: cachedSessions.length > 0 ? `👤 ${cachedSessions[0].account?.label}` : '👤 Not Signed In'
    });

    if (selected) {
        if (selected.id === 'switch') {
            // To switch accounts, we need to clear preference and re-auth
            try {
                await vscode.authentication.getSession('google', [], {
                    createIfNone: true,
                    clearSessionPreference: true
                });
                vscode.window.showInformationMessage('Select the account from the popup at bottom-left');
                setTimeout(refreshSessions, 3000);
            } catch (e) {
                vscode.window.showErrorMessage('Switch failed: ' + e.message);
            }
        } else if (selected.id === 'add-google') {
            await signInWithProvider('google');
        } else if (selected.id === 'dashboard') {
            vscode.commands.executeCommand('antigravity.openDashboard');
        } else if (selected.id === 'refresh') {
            await refreshSessions();
            vscode.window.showInformationMessage('Accounts refreshed');
        }
    }
}

async function signInWithProvider(providerId) {
    try {
        const hasExistingSession = cachedSessions.length > 0;

        const session = await vscode.authentication.getSession(providerId, [], {
            createIfNone: true,
            forceNewSession: hasExistingSession
        });

        if (session) {
            vscode.window.showInformationMessage(`Signed in as ${session.account.label}`);
            await refreshSessions();
        }
    } catch (error) {
        if (error.message.includes('Timed out')) {
            vscode.window.showWarningMessage('Sign-in pending - check the Accounts icon at bottom-left of the window');
        } else {
            vscode.window.showErrorMessage(`Sign in failed: ${error.message}`);
        }
    }
}

// ==================== DEACTIVATION ====================

function deactivate() {
    if (pollInterval) clearInterval(pollInterval);
    if (accountPollInterval) clearInterval(accountPollInterval);
    console.log('[Claude Proxy] Extension deactivated');
}

module.exports = { activate, deactivate };
