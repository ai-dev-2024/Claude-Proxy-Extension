const vscode = require('vscode');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const url = require('url');

// ==================== STATE ====================
let proxyProcess = null;

let modelStatusBarItem = null;
let accountStatusBarItem = null; // Account status bar with direct Google OAuth
let currentModel = 'unknown';
let pollInterval = null;
let accountPollInterval = null;
let quotaPollInterval = null;
let isProxyOnline = false;
let extensionContext = null;

let cachedQuotas = {}; // Store quota data and active account info

// Window-local model key for workspaceState
const WINDOW_MODEL_KEY = 'antigravity.windowModel';
const ACCOUNTS_STORAGE_KEY = 'antigravity.googleAccounts';

// Poll intervals
const PROXY_POLL_INTERVAL_MS = 5000; // 5 seconds for proxy health
const ACCOUNT_POLL_INTERVAL_MS = 300000; // 5 minutes for accounts
const QUOTA_POLL_INTERVAL_MS = 60000; // 60 seconds for quotas (direct API)

// ==================== GOOGLE OAUTH CONFIG ====================
const OAUTH_CONFIG = {
    clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    clientSecret: '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',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    callbackPort: 51122, // Different from proxy to avoid conflicts
    scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/cclog',
        'https://www.googleapis.com/auth/experimentsandconfigs'
    ]
};

// Google AI API endpoints for fetching quotas
const CLOUDCODE_API_ENDPOINT = 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels';

// Headers for Antigravity API
const ANTIGRAVITY_HEADERS = {
    'User-Agent': 'antigravity/1.11.5 vscode-extension',
    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'Client-Metadata': JSON.stringify({
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI'
    })
};

// Available models for quick switching
const MODELS = [
    { label: '⚡ Flash', model: 'gemini-3-flash', description: 'Fast tasks, simple commands' },
    { label: '💎 Pro', model: 'gemini-3-pro-high', description: 'Complex coding, deep analysis' },
    { label: '🎭 Opus', model: 'claude-opus-4-5-thinking', description: 'Complex reasoning' },
    { label: '🎵 Sonnet', model: 'claude-sonnet-4-5-thinking', description: 'Balanced performance' },
    { label: '🌐 Grok', model: 'pplx-grok', description: 'Grok with web search' },
    { label: '🔍 Perplexity', model: 'sonar', description: 'Web search focused' },
];

// ==================== ACTIVATION ====================

function activate(context) {
    console.log('[Antigravity] Extension activated');

    // Store context globally for workspaceState access
    extensionContext = context;

    // Load window-local model if available
    const savedWindowModel = context.workspaceState.get(WINDOW_MODEL_KEY);
    if (savedWindowModel) {
        currentModel = savedWindowModel;
        console.log(`[Antigravity] Loaded window model: ${savedWindowModel}`);
    }

    // ==================== COMMANDS ====================

    // Command to open the dashboard in default browser
    let openDashboardCmd = vscode.commands.registerCommand('antigravity.openDashboard', async function () {
        const dashboardUrl = vscode.Uri.parse('http://localhost:8080/dashboard');
        vscode.env.openExternal(dashboardUrl);
    });
    context.subscriptions.push(openDashboardCmd);

    // Command to switch model via quick pick (window-local)
    let switchModelCmd = vscode.commands.registerCommand('antigravity.switchModel', async function () {
        const selected = await vscode.window.showQuickPick(MODELS, {
            placeHolder: `Current: ${getDisplayName(currentModel)} - Select new model for THIS window`,
            title: '🧠 Switch Model (This Window Only)'
        });

        if (selected) {
            // Store locally for this window
            await setWindowModel(selected.model);
            // Also sync to proxy for backwards compatibility
            setModelOnProxy(selected.model).catch(() => { });
        }
    });
    context.subscriptions.push(switchModelCmd);

    // Command to show current model
    let showModelCmd = vscode.commands.registerCommand('antigravity.showCurrentModel', async function () {
        await refreshModelFromProxyAsync();

        const action = await vscode.window.showInformationMessage(
            `🧠 Current Model: ${getDisplayName(currentModel)}`,
            'Switch Model', 'Open Dashboard', 'Refresh'
        );

        if (action === 'Switch Model') {
            vscode.commands.executeCommand('antigravity.switchModel');
        } else if (action === 'Open Dashboard') {
            vscode.commands.executeCommand('antigravity.openDashboard');
        } else if (action === 'Refresh') {
            refreshModelFromProxyAsync();
        }
    });
    context.subscriptions.push(showModelCmd);

    // NEW: Account switching command
    let switchAccountCmd = vscode.commands.registerCommand('antigravity.switchAccount', showAccountPicker);
    context.subscriptions.push(switchAccountCmd);

    // NEW: Refresh accounts command
    let refreshAccountsCmd = vscode.commands.registerCommand('antigravity.refreshAccounts', async () => {
        await refreshQuotas();
        vscode.window.showInformationMessage('Account quotas refreshed');
    });
    context.subscriptions.push(refreshAccountsCmd);

    // NEW: Add Account is now alias for Switch Account (as we only support one active Google account)
    let addAccountCmd = vscode.commands.registerCommand('antigravity.addAccount', showAccountPicker);
    context.subscriptions.push(addAccountCmd);

    // ==================== STATUS BAR ITEMS ====================

    // NEW: Account Status Bar (leftmost - priority 102)
    accountStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 102);
    accountStatusBarItem.text = '👤';
    accountStatusBarItem.tooltip = 'Loading accounts...';
    accountStatusBarItem.command = 'antigravity.switchAccount';
    accountStatusBarItem.show();
    context.subscriptions.push(accountStatusBarItem);

    // NOTE: Dashboard $(server) icon removed - accessible via account icon hover tooltip

    // Model Status Bar Item (priority 100)
    modelStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    modelStatusBarItem.text = "$(sync~spin) Connecting...";
    modelStatusBarItem.tooltip = "Connecting to proxy...";
    modelStatusBarItem.command = "antigravity.switchModel";
    modelStatusBarItem.show();
    context.subscriptions.push(modelStatusBarItem);

    // ==================== AUTH SESSION LISTENER ====================

    // Listen for authentication changes
    vscode.authentication.onDidChangeSessions(async (e) => {
        console.log('[Antigravity] Auth sessions changed:', e.provider.id);
        await refreshSessions();
    });

    // ==================== POLLING ====================

    // Initial proxy health check
    initialConnect();

    // Initial quota fetch (handling account check)
    refreshQuotas();

    // Poll proxy health status
    pollInterval = setInterval(() => {
        checkProxyHealth().catch(() => { })
    }, PROXY_POLL_INTERVAL_MS);

    // Account polling is now handled by refreshQuotas exclusively
    // We removed separate accountPollInterval to avoid redundant auth calls

    context.subscriptions.push({
        dispose: () => {
            if (pollInterval) clearInterval(pollInterval);
            if (accountPollInterval) clearInterval(accountPollInterval);
            if (quotaPollInterval) clearInterval(quotaPollInterval);
        }
    });

    // Initial quota fetch and poll
    refreshQuotas();
    quotaPollInterval = setInterval(refreshQuotas, QUOTA_POLL_INTERVAL_MS);
}

// ==================== PROXY FUNCTIONS ====================

async function initialConnect() {
    for (let i = 0; i < 5; i++) {
        try {
            await checkProxyHealth();
            if (isProxyOnline) {
                console.log('[Antigravity] Connected to proxy');
                updateModelStatusBar();
                // Fetch quotas now that proxy is confirmed online
                refreshQuotas();
                return;
            }
        } catch (e) {
            console.log(`[Antigravity] Connection attempt ${i + 1} failed`);
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    console.log('[Antigravity] Could not connect to proxy after 5 attempts');
}

function checkProxyHealth() {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 8080,
            path: '/health',
            method: 'GET',
            timeout: 2000
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    const wasOffline = !isProxyOnline;
                    isProxyOnline = true;
                    if (wasOffline) {
                        updateModelStatusBar();
                    }
                    resolve(true);
                } else {
                    isProxyOnline = false;
                    updateStatusBarOffline();
                    reject(new Error('Unhealthy'));
                }
            });
        });

        req.on('error', (err) => {
            isProxyOnline = false;
            updateStatusBarOffline();
            reject(err);
        });

        req.on('timeout', () => {
            req.destroy();
            isProxyOnline = false;
            updateStatusBarOffline();
            reject(new Error('Timeout'));
        });

        req.end();
    });
}

function refreshModelFromProxyAsync() {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 8080,
            path: '/active-model',
            method: 'GET',
            timeout: 2000
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.model) {
                        isProxyOnline = true;
                        resolve(json.model);
                    } else {
                        reject(new Error('No model in response'));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', (err) => {
            isProxyOnline = false;
            updateStatusBarOffline();
            reject(err);
        });

        req.on('timeout', () => {
            req.destroy();
            isProxyOnline = false;
            updateStatusBarOffline();
            reject(new Error('Timeout'));
        });

        req.end();
    });
}

function updateStatusBarOffline() {
    if (modelStatusBarItem) {
        modelStatusBarItem.text = "$(warning) Offline";
        modelStatusBarItem.tooltip = "Proxy offline - click to switch model when online";
    }
}

function setModelOnProxy(model) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ model: model });

        const options = {
            hostname: 'localhost',
            port: 8080,
            path: '/active-model',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 5000
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    currentModel = model;
                    isProxyOnline = true;
                    updateModelStatusBar();
                    vscode.window.showInformationMessage(`🧠 Model set to: ${getDisplayName(model)}`);
                    resolve();
                } else {
                    vscode.window.showErrorMessage(`Failed to set model: ${data}`);
                    reject(new Error(data));
                }
            });
        });

        req.on('error', (err) => {
            vscode.window.showErrorMessage(`Could not connect to proxy: ${err.message}`);
            reject(err);
        });

        req.on('timeout', () => {
            req.destroy();
            vscode.window.showErrorMessage('Request timeout - proxy not responding');
            reject(new Error('Timeout'));
        });

        req.write(postData);
        req.end();
    });
}

function getDisplayName(model) {
    if (!model) return '❓ Unknown';
    const m = model.toLowerCase();
    if (m.includes('gemini-3-flash') || m === 'flash') return '⚡ Flash';
    if (m.includes('gemini-3-pro') || m === 'pro') return '💎 Pro';
    if (m.includes('opus')) return '🎭 Opus';
    if (m.includes('sonnet')) return '🎵 Sonnet';
    if (m.includes('haiku')) return '📝 Haiku';
    if (m.includes('grok')) return '🌐 Grok';
    if (m.includes('pplx') || m.includes('sonar') || m.includes('kimi')) return '🔍 Perplexity';
    if (model.length > 20) {
        return model.substring(0, 17) + '...';
    }
    return model;
}

// ==================== WINDOW-LOCAL MODEL MANAGEMENT ====================

async function setWindowModel(model) {
    if (!extensionContext) {
        console.log('[Antigravity] No context - cannot save window model');
        return;
    }

    currentModel = model;
    await extensionContext.workspaceState.update(WINDOW_MODEL_KEY, model);
    updateModelStatusBar();
    vscode.window.showInformationMessage(`🧠 This window now uses: ${getDisplayName(model)}`);
    console.log(`[Antigravity] Window model set to: ${model}`);
}

function getWindowModel() {
    if (!extensionContext) return currentModel;
    return extensionContext.workspaceState.get(WINDOW_MODEL_KEY) || currentModel;
}

function updateModelStatusBar() {
    if (modelStatusBarItem) {
        const displayName = getDisplayName(currentModel);
        modelStatusBarItem.text = displayName;
        modelStatusBarItem.tooltip = `This Window: ${currentModel}\nClick to switch (window-local)`;
        modelStatusBarItem.backgroundColor = undefined;
    }
}

// ==================== ACCOUNT SESSION MANAGEMENT ====================

// ==================== QUOTA & ACCOUNT MANAGEMENT ====================
// Consolidated logic: We fetch the Google session AND the quotas in one go.


async function refreshAccounts() {
    try {
        // Get ALL Google Sessions directly from VS Code
        const sessions = await vscode.authentication.getSessions('google', [
            'https://www.googleapis.com/auth/cloud-platform',
            'https://www.googleapis.com/auth/userinfo.email'
        ], { createIfNone: false });

        if (!sessions || sessions.length === 0) {
            console.log('[Antigravity] No active Google sessions');
            cachedQuotas = { accounts: [], totalAccounts: 0 };
            updateAccountStatusBar();
            return;
        }

        console.log(`[Antigravity] Found ${sessions.length} Google sessions`);

        // Fetch quotas for EACH session directly from Google API (not proxy)
        const accountResults = await Promise.all(sessions.map(async (session) => {
            try {
                const data = await fetchGoogleQuotas(session.accessToken);
                return {
                    email: session.account.label,
                    id: session.account.id,
                    session: session,
                    limits: processQuotaData(data),
                    status: 'ok'
                };
            } catch (e) {
                console.error(`[Antigravity] Failed to fetch quota for ${session.account.label}:`, e.message);
                return {
                    email: session.account.label,
                    id: session.account.id,
                    session: session,
                    limits: {},
                    status: 'error',
                    error: e.message
                };
            }
        }));

        cachedQuotas = {
            accounts: accountResults,
            totalAccounts: sessions.length,
            activeSessionId: (await getActiveSessionId())
        };

        updateAccountStatusBar();
        console.log('[Antigravity] Account quotas refreshed');

    } catch (e) {
        if (e.message && e.message.includes('Timed out')) {
            console.warn('[Antigravity] Auth provider timed out - transient during startup.');
        } else {
            console.error('[Antigravity] Error refreshing accounts:', e.message);
        }
    }
}

// Alias for backwards compatibility
const refreshQuotas = refreshAccounts;

async function getActiveSessionId() {
    try {
        // This returns the "preferred" session if one exists
        const session = await vscode.authentication.getSession('google', [
            'https://www.googleapis.com/auth/cloud-platform',
            'https://www.googleapis.com/auth/userinfo.email'
        ], { createIfNone: false, silent: true });
        return session ? session.id : null;
    } catch (e) { return null; }
}

function fetchGoogleQuotas(token) {
    return new Promise((resolve, reject) => {
        const urlParsed = url.parse(CLOUDCODE_API_ENDPOINT);
        const options = {
            hostname: urlParsed.hostname,
            path: urlParsed.path,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                ...ANTIGRAVITY_HEADERS
            },
            timeout: 10000
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error('Invalid JSON response'));
                    }
                } else {
                    reject(new Error(`API Error: ${res.statusCode} ${data}`));
                }
            });
        });

        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout'));
        });

        req.write('{}'); // Empty body required
        req.end();
    });
}

function processQuotaData(data) {
    if (!data || !data.models) return {};

    const quotas = {};
    for (const [modelId, modelData] of Object.entries(data.models)) {
        if (modelData.quotaInfo) {
            quotas[modelId] = {
                remainingFraction: modelData.quotaInfo.remainingFraction ?? null,
                resetTime: modelData.quotaInfo.resetTime ?? null
            };
        }
    }
    return quotas;
}

function getModelIcon(modelId) {
    if (!modelId) return '🔘';
    const m = modelId.toLowerCase();
    if (m.includes('flash')) return '⚡';
    if (m.includes('pro')) return '💎';
    if (m.includes('opus')) return '🎭';
    if (m.includes('sonnet')) return '🎵';
    if (m.includes('haiku')) return '📝';
    if (m.includes('grok')) return '🌐';
    if (m.includes('sonar') || m.includes('pplx') || m.includes('kimi')) return '🔍';
    return '🤖';
}

function createProgressBar(fraction, width = 10) {
    if (fraction === null || fraction === undefined) return '░'.repeat(width);
    const filled = Math.round(fraction * width);
    const empty = width - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
}

function updateAccountStatusBar() {
    if (!accountStatusBarItem) return;

    if (!cachedQuotas || !cachedQuotas.accounts || cachedQuotas.accounts.length === 0) {
        accountStatusBarItem.text = '👤+';
        accountStatusBarItem.tooltip = createAccountsTooltip(); // Show "Sign In" tooltip
        accountStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        accountStatusBarItem.text = '👤';
        accountStatusBarItem.tooltip = createAccountsTooltip();
        accountStatusBarItem.backgroundColor = undefined;
    }
}

function updateAccountStatusBarError() {
    if (!accountStatusBarItem) return;

    accountStatusBarItem.text = '👤';
    accountStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`### ⚠️ Error\n\n`);
    md.appendMarkdown(`Could not retrieve account sessions\n\n`);
    md.appendMarkdown(`[🔄 Retry](command:antigravity.refreshAccounts)`);
    accountStatusBarItem.tooltip = md;
}

function createNoAccountsTooltip() {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`### 👤 No Accounts\n\n`);
    md.appendMarkdown(`Click to sign in to an account\n\n`);
    md.appendMarkdown(`[➕ Add Account](command:antigravity.addAccount)`);
    return md;
}

function createAccountsTooltip() {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = true;

    if (!cachedQuotas || !cachedQuotas.accounts || cachedQuotas.accounts.length === 0) {
        md.appendMarkdown(`### 👤 No Accounts\n\n`);
        md.appendMarkdown(`Sign in to use Antigravity\n\n`);
        md.appendMarkdown(`[➕ Sign In](command:antigravity.addAccount)`);
        return md;
    }

    md.appendMarkdown(`### 👤 Google Accounts (${cachedQuotas.totalAccounts})\n\n`);

    // List all accounts with quotas
    for (const acc of cachedQuotas.accounts) {
        const isActive = acc.id === cachedQuotas.activeSessionId;
        const icon = isActive ? '🟢' : '⚪';
        const status = isActive ? '(Active)' : '';

        md.appendMarkdown(`${icon} **${acc.email}** ${status}\n\n`);

        if (acc.status === 'ok') {
            const quotas = acc.limits;
            if (Object.keys(quotas).length > 0) {
                const modelsToShow = ['gemini-3-flash', 'claude-sonnet-4-5'];
                for (const mId of modelsToShow) {
                    const key = Object.keys(quotas).find(k => k.includes(mId));
                    if (key) {
                        const q = quotas[key];
                        const pct = q.remainingFraction !== null ? Math.round(q.remainingFraction * 100) : 0;
                        md.appendMarkdown(`&nbsp;&nbsp;${getModelIcon(key)} ${pct}% `);
                    }
                }
                md.appendMarkdown(`\n\n`);
            } else {
                md.appendMarkdown(`&nbsp;&nbsp;_No quota info_\n\n`);
            }
        } else {
            md.appendMarkdown(`&nbsp;&nbsp;⚠️ Error fetching quotas\n\n`);
        }
        md.appendMarkdown(`---\n`);
    }

    // Actions with dashboard link
    md.appendMarkdown(`[🔄 Switch Account](command:antigravity.switchAccount) | `);
    md.appendMarkdown(`[➕ Add Account](command:antigravity.addAccount) | `);
    md.appendMarkdown(`[📊 Dashboard](command:antigravity.openDashboard) | `);
    md.appendMarkdown(`[⚡ Refresh](command:antigravity.refreshAccounts)`);

    return md;
}

function renderQuotaLine(md, modelId, quota) {
    const pct = quota.remainingFraction !== null ? Math.round(quota.remainingFraction * 100) : 0;
    const icon = getModelIcon(modelId);
    const shortName = modelId.length > 20 ? modelId.substring(0, 17) + '...' : modelId;

    // Color coding for progress bar
    let progressChar = '█';
    if (pct < 20) progressChar = '🟥'; // Warning when low

    md.appendMarkdown(`${icon} **${shortName}**\n`);
    md.appendMarkdown(`${createProgressBar(quota.remainingFraction)}\n`);
    md.appendMarkdown(`Available: ${pct}%\n\n`);
}

function getProviderIcon(providerId) {
    switch (providerId) {
        case 'google': return '🔵';
        case 'github': return '⚫';
        case 'microsoft': return '🟦';
        default: return '🔘';
    }
}

// ==================== ACCOUNT PICKER ====================

async function showAccountPicker() {
    if (!cachedQuotas || !cachedQuotas.accounts) {
        await refreshQuotas();
    }

    const items = [];
    const accounts = cachedQuotas ? cachedQuotas.accounts : [];

    // List existing accounts to "Switch" to
    for (const acc of accounts) {
        const isActive = acc.id === cachedQuotas.activeSessionId;
        items.push({
            label: `${isActive ? '🟢' : '⚪'} ${acc.email}`,
            description: isActive ? 'Currently Active' : 'Click to Activate',
            detail: 'Switch VS Code to use this account',
            id: 'activate',
            session: acc.session
        });
    }

    if (items.length > 0) {
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }

    // Add New
    items.push({
        label: '$(add) Add Another Google Account',
        description: 'Sign in with a new account',
        id: 'add'
    });

    items.push({
        label: '$(refresh) Refresh Quotas',
        id: 'refresh'
    });

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Manage Antigravity Account',
        title: session ? `👤 Active: ${session.email}` : '👤 Not Signed In'
    });

    if (selected) {
        if (selected.id === 'activate') {
            // SWITCHING ACCOUNT
            // We use clearSessionPreference: true to prompt the user to pick this specific account
            // We do NOT use forceNewSession because the session already exists
            try {
                await vscode.authentication.getSession('google', [
                    'https://www.googleapis.com/auth/cloud-platform',
                    'https://www.googleapis.com/auth/userinfo.email'
                ], {
                    createIfNone: true,
                    clearSessionPreference: true
                });

                vscode.window.showInformationMessage('Please select the desired account in the prompt.');
                setTimeout(refreshQuotas, 2000);

            } catch (e) {
                if (e.message.includes('Timed out')) {
                    vscode.window.showErrorMessage('Timed Out: Check the "Accounts" icon (bottom-left) for a pending action.');
                } else {
                    vscode.window.showErrorMessage('Switch failed: ' + e.message);
                }
            }
        } else if (selected.id === 'add') {
            // ADDING NEW ACCOUNT
            // If we have no accounts, just "createIfNone" is enough (simpler, less prone to timeouts).
            // If we already have accounts, we MUST use "forceNewSession" to add another.
            const hasAccounts = cachedQuotas && cachedQuotas.accounts && cachedQuotas.accounts.length > 0;

            try {
                await vscode.authentication.getSession('google', [
                    'https://www.googleapis.com/auth/cloud-platform',
                    'https://www.googleapis.com/auth/userinfo.email'
                ], {
                    createIfNone: true,
                    forceNewSession: hasAccounts
                });
                setTimeout(refreshQuotas, 2000);
            } catch (e) {
                if (e.message.includes('Timed out')) {
                    vscode.window.showErrorMessage('Timed Out: Please check the "Accounts" icon (bottom-left) for a pending sign-in action.');
                } else {
                    vscode.window.showErrorMessage('Sign-in failed: ' + e.message);
                }
            }
        } else if (selected.id === 'refresh') {
            refreshQuotas();
            vscode.window.showInformationMessage('Refreshed information');
        }
    }
}

// (Legacy functions removed: signInWithProvider, addNewAccount)
// Everything is now handled via showAccountPicker and direct vscode.authentication calls

// ==================== DEACTIVATION ====================

function deactivate() {
    if (proxyProcess) {
        proxyProcess.kill();
    }
    if (pollInterval) {
        clearInterval(pollInterval);
    }
    if (accountPollInterval) {
        clearInterval(accountPollInterval);
    }
    console.log('[Antigravity] Extension deactivated');
}

module.exports = { activate, deactivate };
