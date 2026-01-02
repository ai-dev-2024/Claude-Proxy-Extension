const vscode = require('vscode');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const crypto = require('crypto');

// ==================== STATE ====================
let quotaStatusBarItem = null;        // Shows quota summary on hover
let modelStatusBarItem = null;        // Model name (shows "Offline" in red when down)
let currentModel = 'unknown';
let isProxyOnline = false;
let pollInterval = null;
let settingsWatcher = null;           // File watcher for Claude Code settings
let proxyQuotaData = null;            // Quota data from proxy /account-limits
let currentIDEAccount = null;         // Antigravity signed-in account
let lastTooltipData = null;           // Cache to prevent tooltip flickering

// Per-window model persistence
let extensionContext = null;          // Store context for workspaceState access
let isFirstConnect = true;            // Track first connection to proxy
let windowId = null;                  // Unique window identifier
const WINDOW_MODEL_KEY = 'antigravity.windowModel';  // workspaceState key for per-window model

// Configuration
const PROXY_POLL_INTERVAL_MS = 5000;
const ACCOUNT_POLL_INTERVAL_MS = 15 * 60 * 1000;  // 15 minutes
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
    console.log('[Claude Proxy] Extension v3.0.0 activated');

    // Store context for workspaceState access in other functions
    extensionContext = context;

    // Generate or retrieve unique window ID
    windowId = context.globalState.get('antigravity.windowId');
    if (!windowId) {
        windowId = crypto.randomUUID();
        context.globalState.update('antigravity.windowId', windowId);
        console.log(`[Claude Proxy] Generated new window ID: ${windowId.slice(0, 8)}...`);
    }

    // Load saved window-local model (persists per-workspace)
    const savedWindowModel = context.workspaceState.get(WINDOW_MODEL_KEY);
    if (savedWindowModel) {
        currentModel = savedWindowModel;
        isFirstConnect = false;  // Don't override with proxy model
        console.log(`[Claude Proxy] Loaded saved model for this window: ${savedWindowModel}`);
    }


    // ==================== STATUS BAR ITEMS (2 icons) ====================

    // 1. Account/Quota Status Bar (priority 101 - left) - Click to show quota info
    quotaStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    quotaStatusBarItem.text = '$(account)';
    quotaStatusBarItem.tooltip = 'Click to view quota info';  // Static tooltip
    quotaStatusBarItem.command = 'antigravity.showQuotaInfo';
    quotaStatusBarItem.show();
    context.subscriptions.push(quotaStatusBarItem);

    // 2. Model Status Bar (priority 100 - right of quota)
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

    // Show quota info command - Quick Pick style popup
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.showQuotaInfo', async () => {
            await showQuotaQuickPick();
        })
    );

    // ==================== POLLING ====================
    checkProxyHealth();
    fetchProxyQuotaData();
    fetchIDEAccount();  // Fetch Antigravity signed-in account
    pollInterval = setInterval(() => {
        checkProxyHealth();
        fetchProxyQuotaData();
    }, PROXY_POLL_INTERVAL_MS);

    // Listen for auth changes - refresh account immediately
    context.subscriptions.push(
        vscode.authentication.onDidChangeSessions(() => {
            fetchIDEAccount();
        })
    );

    // Periodic account refresh (every 15 minutes to avoid flickering)
    setInterval(() => {
        fetchIDEAccount();
    }, ACCOUNT_POLL_INTERVAL_MS);

    // ==================== WATCH CLAUDE CODE SETTINGS ====================
    watchClaudeSettings();

    // Listen for VS Code configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('claudeCode.selectedModel')) {
                const config = vscode.workspace.getConfiguration('claudeCode');
                const newModel = config.get('selectedModel');
                if (newModel && newModel !== currentModel) {
                    console.log(`[Claude Proxy] Config changed: selectedModel = ${newModel}`);
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

// ==================== QUOTA STATUS BAR ====================

function updateQuotaStatusBar() {
    if (!quotaStatusBarItem) return;

    // Static tooltip - never changes, prevents flickering
    quotaStatusBarItem.tooltip = 'Click to view quota info';

    if (!isProxyOnline) {
        quotaStatusBarItem.text = '$(account) Offline';
        return;
    }

    // Show account name if available
    if (currentIDEAccount) {
        const shortEmail = currentIDEAccount.email.split('@')[0];
        quotaStatusBarItem.text = `$(account) ${shortEmail}`;
    } else {
        quotaStatusBarItem.text = '$(account)';
    }
}

// Show quota info as a Quick Pick popup (like hover tooltip but on click)
async function showQuotaQuickPick() {
    const items = [];

    // Header separator - clean label without icons
    items.push({
        label: 'Model Quotas',
        kind: vscode.QuickPickItemKind.Separator
    });

    if (!proxyQuotaData) {
        items.push({ label: '$(sync~spin) Loading quota data...', description: '' });
    } else {
        // Claude quota
        if (proxyQuotaData.claudeQuota !== null) {
            const bar = createSmallQuotaBar(proxyQuotaData.claudeQuota);
            items.push({
                label: `🟠 Claude: ${bar} ${proxyQuotaData.claudeQuota}%`,
                description: 'Overall',
                detail: proxyQuotaData.claudeModels?.slice(0, 3).map(m => `${m.id.replace('claude-', '')}: ${m.quota}%`).join(' • ')
            });
        }

        // Gemini quota
        if (proxyQuotaData.geminiQuota !== null) {
            const bar = createSmallQuotaBar(proxyQuotaData.geminiQuota);
            items.push({
                label: `💎 Gemini: ${bar} ${proxyQuotaData.geminiQuota}%`,
                description: 'Overall',
                detail: proxyQuotaData.geminiModels?.slice(0, 3).map(m => `${m.id.replace('gemini-', '')}: ${m.quota}%`).join(' • ')
            });
        }

        // Per-account breakdown - clean label
        if (proxyQuotaData.accounts && proxyQuotaData.accounts.length > 0) {
            items.push({
                label: `${proxyQuotaData.totalAccounts} Google Account(s)`,
                kind: vscode.QuickPickItemKind.Separator
            });

            // Pre-calculate Claude quota for each account for sorting
            const accountsWithQuota = proxyQuotaData.accounts.map(acc => {
                let claudePct = null, geminiPct = null;
                let claudeReset = null, geminiReset = null;

                if (acc.limits) {
                    for (const [modelId, info] of Object.entries(acc.limits)) {
                        if (modelId.includes('claude')) {
                            if (info.remainingFraction !== undefined && info.remainingFraction !== null) {
                                const pct = Math.round(info.remainingFraction * 100);
                                if (claudePct === null || pct < claudePct) claudePct = pct;
                            }
                            if (info.resetTime) claudeReset = info.resetTime;
                        } else if (modelId.includes('gemini')) {
                            if (info.remainingFraction !== undefined && info.remainingFraction !== null) {
                                const pct = Math.round(info.remainingFraction * 100);
                                if (geminiPct === null || pct < geminiPct) geminiPct = pct;
                            }
                            if (info.resetTime) geminiReset = info.resetTime;
                        }
                    }
                }

                return { acc, claudePct, geminiPct, claudeReset, geminiReset };
            });

            // Sort by Claude quota descending (accounts with Claude available at top)
            accountsWithQuota.sort((a, b) => {
                const aPct = a.claudePct !== null ? a.claudePct : -1;
                const bPct = b.claudePct !== null ? b.claudePct : -1;
                return bPct - aPct;  // Descending
            });

            for (const { acc, claudePct, geminiPct, claudeReset, geminiReset } of accountsWithQuota) {
                const shortEmail = acc.email.split('@')[0];

                const claudeStr = claudePct !== null ? `${createSmallQuotaBar(claudePct)} ${claudePct}%` : '—';
                const geminiStr = geminiPct !== null ? `${createSmallQuotaBar(geminiPct)} ${geminiPct}%` : '—';

                let detail = `🟠 Claude: ${claudeStr}`;
                if (claudeReset && claudePct < 100) detail += ` (resets ${formatResetTime(new Date(claudeReset))})`;
                detail += `  •  💎 Gemini: ${geminiStr}`;
                if (geminiReset && geminiPct < 100) detail += ` (resets ${formatResetTime(new Date(geminiReset))})`;

                items.push({
                    label: `👤 ${shortEmail}`,
                    detail: detail
                });
            }
        }

        // Open Dashboard option
        items.push({
            label: '',
            kind: vscode.QuickPickItemKind.Separator
        });
        items.push({
            label: '$(link-external) Open Dashboard',
            description: 'View full details in browser',
            alwaysShow: true,
            action: 'dashboard'
        });
    }

    const selected = await vscode.window.showQuickPick(items, {
        title: 'Antigravity Quota Info',
        placeHolder: 'Account and model quota information',
        matchOnDetail: true
    });

    if (selected && selected.action === 'dashboard') {
        vscode.env.openExternal(vscode.Uri.parse('http://localhost:8080/dashboard#overview'));
    }
}

// Fetch Antigravity signed-in account using language server API (like UsageBar)
async function fetchIDEAccount() {
    try {
        // Step 1: Find Antigravity language server process and extract CSRF token
        const processInfo = await detectAntigravityProcess();
        if (!processInfo) {
            currentIDEAccount = null;
            return;
        }

        // Step 2: Get listening ports for the process
        const ports = await getProcessPorts(processInfo.pid);
        if (ports.length === 0) {
            console.log('[Claude Proxy] No listening ports found');
            currentIDEAccount = null;
            return;
        }

        // Step 3: Call GetUserStatus API on each port until one works
        for (const port of ports) {
            try {
                const userStatus = await callGetUserStatus(port, processInfo.csrfToken);
                if (userStatus && userStatus.email) {
                    console.log(`[Claude Proxy] Found Antigravity account: ${userStatus.email}`);
                    currentIDEAccount = {
                        provider: 'antigravity',
                        email: userStatus.email,
                        plan: userStatus.plan
                    };
                    updateQuotaStatusBar();
                    return;
                }
            } catch (e) {
                // Try next port
            }
        }

        console.log('[Claude Proxy] Could not get user status from any port');
        currentIDEAccount = null;
    } catch (e) {
        console.log('[Claude Proxy] Could not fetch Antigravity account:', e.message);
        currentIDEAccount = null;
    }
}

// Detect Antigravity language server process (Windows)
function detectAntigravityProcess() {
    return new Promise((resolve) => {
        exec('wmic process where "Name like \'%language_server%\'" get ProcessId,CommandLine /format:list',
            { timeout: 5000, maxBuffer: 10 * 1024 * 1024 },
            (error, stdout) => {
                if (error || !stdout || stdout.trim() === '') {
                    resolve(null);
                    return;
                }

                // Parse WMIC output
                const entries = stdout.split(/\r?\n\r?\n/).filter(block => block.trim());
                for (const entry of entries) {
                    const lines = entry.split(/\r?\n/).filter(l => l.trim());
                    let commandLine = '';
                    let pid = 0;

                    for (const line of lines) {
                        if (line.startsWith('CommandLine=')) {
                            commandLine = line.substring('CommandLine='.length);
                        } else if (line.startsWith('ProcessId=')) {
                            pid = parseInt(line.substring('ProcessId='.length), 10);
                        }
                    }

                    if (!commandLine || !pid) continue;

                    // Extract CSRF token
                    const csrfMatch = commandLine.match(/--csrf_token[=\s]+([^\s"]+)/i);
                    if (csrfMatch && csrfMatch[1]) {
                        resolve({ pid, csrfToken: csrfMatch[1], commandLine });
                        return;
                    }
                }
                resolve(null);
            }
        );
    });
}

// Get listening ports for a process (Windows)
function getProcessPorts(pid) {
    return new Promise((resolve) => {
        exec(`netstat -ano | findstr "${pid}" | findstr "LISTENING"`,
            { timeout: 5000 },
            (error, stdout) => {
                if (error || !stdout) {
                    resolve([]);
                    return;
                }

                const ports = new Set();
                const lines = stdout.split('\n');
                for (const line of lines) {
                    const match = line.match(/:(\d+)\s+[\d.:]+\s+LISTENING/);
                    if (match && match[1]) {
                        ports.add(parseInt(match[1], 10));
                    }
                }
                resolve(Array.from(ports).sort((a, b) => a - b));
            }
        );
    });
}

// Call GetUserStatus API on the language server
function callGetUserStatus(port, csrfToken) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
        });

        const options = {
            hostname: '127.0.0.1',
            port: port,
            path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': csrfToken
            },
            rejectUnauthorized: false,
            timeout: 3000
        };

        // Try HTTPS first
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const userStatus = json.userStatus;
                    if (userStatus) {
                        const planInfo = userStatus.planStatus?.planInfo;
                        resolve({
                            email: userStatus.email,
                            plan: planInfo?.planDisplayName || planInfo?.planName
                        });
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', (e) => {
            // Try HTTP fallback
            const httpReq = http.request({ ...options, protocol: undefined }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const userStatus = json.userStatus;
                        if (userStatus) {
                            const planInfo = userStatus.planStatus?.planInfo;
                            resolve({
                                email: userStatus.email,
                                plan: planInfo?.planDisplayName || planInfo?.planName
                            });
                        } else {
                            resolve(null);
                        }
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            httpReq.on('error', reject);
            httpReq.write(body);
            httpReq.end();
        });

        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(body);
        req.end();
    });
}

// ==================== QUOTA DATA ====================

function fetchProxyQuotaData() {
    const req = http.request({
        hostname: 'localhost',
        port: 8080,
        path: '/account-limits',
        method: 'GET',
        timeout: 5000
    }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                const json = JSON.parse(data);
                proxyQuotaData = processQuotaData(json);
                updateQuotaStatusBar();
            } catch (e) {
                console.log('[Claude Proxy] Could not parse quota data:', e.message);
            }
        });
    });

    req.on('error', () => {
        proxyQuotaData = null;
        updateQuotaStatusBar();
    });
    req.on('timeout', () => req.destroy());
    req.end();
}

// Process quota data - aggregate by model family
function processQuotaData(json) {
    if (!json || !json.accounts || json.accounts.length === 0) {
        return { claudeQuota: null, geminiQuota: null, accounts: [], models: {} };
    }

    const accounts = json.accounts;
    const modelQuotas = {}; // { modelId: [pct1, pct2, ...] }
    const accountSummaries = [];

    for (const acc of accounts) {
        if (acc.status !== 'ok' || !acc.limits) continue;

        for (const [modelId, info] of Object.entries(acc.limits)) {
            if (info.remainingFraction !== undefined && info.remainingFraction !== null) {
                const pct = Math.round(info.remainingFraction * 100);
                if (!modelQuotas[modelId]) modelQuotas[modelId] = [];
                modelQuotas[modelId].push(pct);
            }
        }

        accountSummaries.push({
            email: acc.email,
            limits: acc.limits
        });
    }

    // Aggregate by family - use MINIMUM across accounts (conservative)
    let claudeQuota = null;
    let geminiQuota = null;
    const claudeModels = [];
    const geminiModels = [];

    for (const [modelId, pcts] of Object.entries(modelQuotas)) {
        const minPct = Math.min(...pcts);

        if (modelId.includes('claude')) {
            claudeModels.push({ id: modelId, quota: minPct });
            if (claudeQuota === null || minPct < claudeQuota) {
                claudeQuota = minPct;
            }
        } else if (modelId.includes('gemini')) {
            geminiModels.push({ id: modelId, quota: minPct });
            if (geminiQuota === null || minPct < geminiQuota) {
                geminiQuota = minPct;
            }
        }
    }

    return {
        claudeQuota: claudeQuota,
        geminiQuota: geminiQuota,
        claudeModels: claudeModels.sort((a, b) => a.id.localeCompare(b.id)),
        geminiModels: geminiModels.sort((a, b) => a.id.localeCompare(b.id)),
        accounts: accountSummaries,
        totalAccounts: json.totalAccounts || accounts.length
    };
}

// ==================== CLAUDE CODE SETTINGS WATCHER ====================

function watchClaudeSettings() {
    try {
        if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) {
            console.log('[Claude Proxy] Claude settings file not found, skipping watch');
            return;
        }

        settingsWatcher = fs.watch(CLAUDE_SETTINGS_PATH, { persistent: false }, (eventType) => {
            if (eventType === 'change') {
                try {
                    const data = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
                    if (data.model && data.model !== currentModel) {
                        console.log(`[Claude Proxy] Detected model change: ${data.model}`);
                        currentModel = data.model;
                        updateModelStatusBar();
                        setModelOnProxy(data.model);
                    }
                } catch (e) {
                    // File being written, ignore
                }
            }
        });

        console.log('[Claude Proxy] Watching Claude settings');
    } catch (e) {
        console.log('[Claude Proxy] Could not watch settings:', e.message);
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

                // Only accept proxy model on FIRST connect if no local model saved
                // This prevents multiple windows from overwriting each other's model
                if (json.model && json.model !== currentModel) {
                    const hasSavedModel = extensionContext && extensionContext.workspaceState.get(WINDOW_MODEL_KEY);
                    if (isFirstConnect && !hasSavedModel) {
                        console.log(`[Claude Proxy] First connect - using proxy model: ${json.model}`);
                        currentModel = json.model;
                    }
                    // Otherwise, keep local model - don't let proxy override
                }
                isFirstConnect = false;

                updateModelStatusBar();
                updateQuotaStatusBar();
            } catch (e) {
                isProxyOnline = false;
                updateModelStatusBar();
                updateQuotaStatusBar();
            }
        });
    });

    req.on('error', () => {
        isProxyOnline = false;
        updateModelStatusBar();
        updateQuotaStatusBar();
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
                    // Save to workspaceState for per-window persistence
                    if (extensionContext) {
                        extensionContext.workspaceState.update(WINDOW_MODEL_KEY, model);
                        console.log(`[Claude Proxy] Saved window model: ${model}`);
                    }
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
        modelStatusBarItem.tooltip = `This Window: ${currentModel}\nClick to switch (per-window)`;
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

// ==================== QUOTA INFO PANEL (Click-to-show) ====================

async function showQuotaInfoPanel() {
    const items = [];

    // Header: Signed-in account
    if (currentIDEAccount) {
        items.push({
            label: '$(account) Antigravity Account',
            description: currentIDEAccount.email,
            kind: vscode.QuickPickItemKind.Separator
        });
    }

    // Proxy status
    if (!isProxyOnline) {
        items.push({
            label: '$(warning) Proxy Offline',
            description: 'Start the proxy to see quota info'
        });
    } else if (!proxyQuotaData) {
        items.push({
            label: '$(sync~spin) Loading...',
            description: 'Fetching quota data'
        });
    } else {
        // Overall quota
        if (proxyQuotaData.claudeQuota !== null) {
            const bar = createSmallQuotaBar(proxyQuotaData.claudeQuota);
            items.push({
                label: `🟠 Claude: ${bar} ${proxyQuotaData.claudeQuota}%`,
                description: 'Overall'
            });
        }
        if (proxyQuotaData.geminiQuota !== null) {
            const bar = createSmallQuotaBar(proxyQuotaData.geminiQuota);
            items.push({
                label: `💎 Gemini: ${bar} ${proxyQuotaData.geminiQuota}%`,
                description: 'Overall'
            });
        }

        // Per-account breakdown
        if (proxyQuotaData.accounts && proxyQuotaData.accounts.length > 0) {
            items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
            items.push({
                label: `$(server) ${proxyQuotaData.totalAccounts} Account(s)`,
                kind: vscode.QuickPickItemKind.Separator
            });

            for (const acc of proxyQuotaData.accounts) {
                const shortEmail = acc.email.split('@')[0];

                if (acc.limits) {
                    let claudePct = null, geminiPct = null;
                    let claudeResetTime = null, geminiResetTime = null;

                    for (const [modelId, info] of Object.entries(acc.limits)) {
                        if (modelId.includes('claude')) {
                            if (info.remainingFraction !== undefined && info.remainingFraction !== null) {
                                const pct = Math.round(info.remainingFraction * 100);
                                if (claudePct === null || pct < claudePct) claudePct = pct;
                            }
                            if (info.resetTime) claudeResetTime = info.resetTime;
                        } else if (modelId.includes('gemini')) {
                            if (info.remainingFraction !== undefined && info.remainingFraction !== null) {
                                const pct = Math.round(info.remainingFraction * 100);
                                if (geminiPct === null || pct < geminiPct) geminiPct = pct;
                            }
                            if (info.resetTime) geminiResetTime = info.resetTime;
                        }
                    }

                    let claudeStr = '';
                    if (claudePct !== null || claudeResetTime) {
                        const pct = claudePct !== null ? claudePct : 0;
                        const bar = createSmallQuotaBar(pct);
                        let resetStr = '';
                        if (claudeResetTime && pct < 100) {
                            resetStr = ` (resets ${formatResetTime(new Date(claudeResetTime))})`;
                        }
                        claudeStr = `🟠 ${bar} ${pct}%${resetStr}`;
                    }

                    let geminiStr = '';
                    if (geminiPct !== null || geminiResetTime) {
                        const pct = geminiPct !== null ? geminiPct : 0;
                        const bar = createSmallQuotaBar(pct);
                        let resetStr = '';
                        if (geminiResetTime && pct < 100) {
                            resetStr = ` (resets ${formatResetTime(new Date(geminiResetTime))})`;
                        }
                        geminiStr = `💎 ${bar} ${pct}%${resetStr}`;
                    }

                    items.push({
                        label: `$(person) ${shortEmail}`,
                        description: [claudeStr, geminiStr].filter(s => s).join('  ')
                    });
                }
            }
        }
    }

    // Footer: Open Dashboard
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({
        label: '$(link-external) Open Dashboard',
        description: 'View full details in browser',
        action: 'dashboard'
    });

    const selected = await vscode.window.showQuickPick(items, {
        title: '📊 Antigravity Quota Info',
        placeHolder: 'Account and quota information'
    });

    if (selected && selected.action === 'dashboard') {
        vscode.env.openExternal(vscode.Uri.parse('http://localhost:8080/dashboard#overview'));
    }
}

// ==================== TOOLTIPS ====================

function createQuotaTooltip() {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    // Header with signed-in account
    if (currentIDEAccount) {
        md.appendMarkdown(`### $(account) Antigravity Account\n\n`);
        md.appendMarkdown(`**${currentIDEAccount.email}**\n\n`);
    } else {
        md.appendMarkdown(`### $(graph) Model Quotas\n\n`);
    }

    if (!proxyQuotaData) {
        md.appendMarkdown(`$(warning) *Loading...*\n\n`);
        md.appendMarkdown(`[$(link-external) Open Dashboard](command:antigravity.openDashboard)`);
        return md;
    }

    // Overall Claude + Gemini summary
    if (proxyQuotaData.claudeQuota !== null || proxyQuotaData.geminiQuota !== null) {
        md.appendMarkdown(`**Overall:**\n`);
        if (proxyQuotaData.claudeQuota !== null) {
            const bar = createSmallQuotaBar(proxyQuotaData.claudeQuota);
            md.appendMarkdown(`- 🟠 Claude: ${bar} ${proxyQuotaData.claudeQuota}%\n`);
        }
        if (proxyQuotaData.geminiQuota !== null) {
            const bar = createSmallQuotaBar(proxyQuotaData.geminiQuota);
            md.appendMarkdown(`- 💎 Gemini: ${bar} ${proxyQuotaData.geminiQuota}%\n`);
        }
        md.appendMarkdown(`\n`);
    }

    // Per-account breakdown with Claude/Gemini quotas and reset times
    if (proxyQuotaData.accounts && proxyQuotaData.accounts.length > 0) {
        md.appendMarkdown(`---\n\n`);
        md.appendMarkdown(`### $(server) ${proxyQuotaData.totalAccounts} Account(s)\n\n`);

        for (const acc of proxyQuotaData.accounts) {
            const shortEmail = acc.email.split('@')[0];
            md.appendMarkdown(`**${shortEmail}**\n`);

            if (acc.limits) {
                // Get Claude quota and reset time
                let claudePct = null;
                let geminiPct = null;
                let claudeResetTime = null;
                let geminiResetTime = null;

                for (const [modelId, info] of Object.entries(acc.limits)) {
                    if (modelId.includes('claude')) {
                        if (info.remainingFraction !== undefined && info.remainingFraction !== null) {
                            const pct = Math.round(info.remainingFraction * 100);
                            if (claudePct === null || pct < claudePct) claudePct = pct;
                        }
                        if (info.resetTime) claudeResetTime = info.resetTime;
                    } else if (modelId.includes('gemini')) {
                        if (info.remainingFraction !== undefined && info.remainingFraction !== null) {
                            const pct = Math.round(info.remainingFraction * 100);
                            if (geminiPct === null || pct < geminiPct) geminiPct = pct;
                        }
                        if (info.resetTime) geminiResetTime = info.resetTime;
                    }
                }

                // Show Claude with reset time (even if 0% or if we only have reset time)
                if (claudePct !== null || claudeResetTime) {
                    const pct = claudePct !== null ? claudePct : 0;
                    let resetStr = '';
                    if (claudeResetTime && pct < 100) {
                        resetStr = ` *(resets ${formatResetTime(new Date(claudeResetTime))})*`;
                    }
                    md.appendMarkdown(`  - 🟠 Claude: ${createSmallQuotaBar(pct)} ${pct}%${resetStr}\n`);
                }

                // Show Gemini with reset time (even if 0% or if we only have reset time)
                if (geminiPct !== null || geminiResetTime) {
                    const pct = geminiPct !== null ? geminiPct : 0;
                    let resetStr = '';
                    if (geminiResetTime && pct < 100) {
                        resetStr = ` *(resets ${formatResetTime(new Date(geminiResetTime))})*`;
                    }
                    md.appendMarkdown(`  - 💎 Gemini: ${createSmallQuotaBar(pct)} ${pct}%${resetStr}\n`);
                }
            }
            md.appendMarkdown(`\n`);
        }
    }

    if (proxyQuotaData.claudeQuota === null && proxyQuotaData.geminiQuota === null) {
        md.appendMarkdown(`$(info) *No quota data available*\n\n`);
    }

    // Footer
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`[$(link-external) Open Dashboard](command:antigravity.openDashboard)`);

    return md;
}

function createSmallQuotaBar(percent) {
    const filled = Math.round(percent / 10);
    const empty = 10 - filled;
    // Use same-size block characters: ▰ for filled, ▱ for empty
    const filledChar = '▰';
    const emptyChar = '▱';
    return filledChar.repeat(filled) + emptyChar.repeat(empty);
}

function formatResetTime(resetDate) {
    const now = new Date();
    const diff = resetDate.getTime() - now.getTime();

    if (diff <= 0) {
        return 'soon';
    }

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 0) {
        return `in ${hours}h ${minutes}m`;
    } else if (minutes > 0) {
        return `in ${minutes}m`;
    } else {
        return 'soon';
    }
}

// ==================== DEACTIVATION ====================

function deactivate() {
    if (pollInterval) clearInterval(pollInterval);
    console.log('[Claude Proxy] Extension deactivated');
}

module.exports = { activate, deactivate };

