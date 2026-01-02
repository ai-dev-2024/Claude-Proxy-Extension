const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ==================== STATE ====================
let quotaStatusBarItem = null;        // Shows quota summary on hover
let modelStatusBarItem = null;        // Model name (shows "Offline" in red when down)
let currentModel = 'unknown';
let isProxyOnline = false;
let pollInterval = null;
let settingsWatcher = null;           // File watcher for Claude Code settings
let proxyQuotaData = null;            // Quota data from proxy /account-limits

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
    console.log('[Claude Proxy] Extension v2.6.0 activated');

    // ==================== STATUS BAR ITEMS (2 icons) ====================

    // 1. Quota Status Bar (priority 101 - left) - Shows quota on hover
    quotaStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    quotaStatusBarItem.text = '$(graph) ...';
    quotaStatusBarItem.command = 'antigravity.openDashboard';
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

    // ==================== POLLING ====================
    checkProxyHealth();
    fetchProxyQuotaData();
    pollInterval = setInterval(() => {
        checkProxyHealth();
        fetchProxyQuotaData();
    }, PROXY_POLL_INTERVAL_MS);

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

    if (!isProxyOnline) {
        quotaStatusBarItem.text = '$(warning)';
        quotaStatusBarItem.tooltip = 'Proxy offline';
        return;
    }

    if (proxyQuotaData && proxyQuotaData.claudeQuota !== null) {
        // Show mini quota bar
        const claudePct = proxyQuotaData.claudeQuota;
        const geminiPct = proxyQuotaData.geminiQuota;

        // Show the lower of the two as indicator
        const minQuota = Math.min(claudePct, geminiPct);
        const icon = minQuota > 50 ? '$(graph)' : minQuota > 20 ? '$(warning)' : '$(error)';
        quotaStatusBarItem.text = icon;
        quotaStatusBarItem.tooltip = createQuotaTooltip();
    } else {
        quotaStatusBarItem.text = '$(graph)';
        quotaStatusBarItem.tooltip = 'Click to open dashboard';
    }
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
                if (json.model && json.model !== currentModel) {
                    currentModel = json.model;
                }
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

// ==================== TOOLTIPS ====================

function createQuotaTooltip() {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    md.appendMarkdown(`### $(graph) Model Quotas\n\n`);

    if (!proxyQuotaData) {
        md.appendMarkdown(`$(warning) *Loading...*\n\n`);
        md.appendMarkdown(`[$(link-external) Open Dashboard](command:antigravity.openDashboard)`);
        return md;
    }

    // Claude models section
    if (proxyQuotaData.claudeQuota !== null) {
        md.appendMarkdown(`**Claude**\n`);
        const claudeBar = createQuotaBar(proxyQuotaData.claudeQuota);
        md.appendMarkdown(`${claudeBar} ${proxyQuotaData.claudeQuota}%\n\n`);

        // Show individual Claude models
        if (proxyQuotaData.claudeModels && proxyQuotaData.claudeModels.length > 0) {
            for (const model of proxyQuotaData.claudeModels.slice(0, 3)) {
                const shortName = model.id.replace('claude-', '').replace('-thinking', '');
                md.appendMarkdown(`  • ${shortName}: ${model.quota}%\n`);
            }
            md.appendMarkdown(`\n`);
        }
    }

    // Gemini models section
    if (proxyQuotaData.geminiQuota !== null) {
        md.appendMarkdown(`**Gemini**\n`);
        const geminiBar = createQuotaBar(proxyQuotaData.geminiQuota);
        md.appendMarkdown(`${geminiBar} ${proxyQuotaData.geminiQuota}%\n\n`);

        // Show individual Gemini models
        if (proxyQuotaData.geminiModels && proxyQuotaData.geminiModels.length > 0) {
            for (const model of proxyQuotaData.geminiModels.slice(0, 3)) {
                const shortName = model.id.replace('gemini-', '');
                md.appendMarkdown(`  • ${shortName}: ${model.quota}%\n`);
            }
            md.appendMarkdown(`\n`);
        }
    }

    if (proxyQuotaData.claudeQuota === null && proxyQuotaData.geminiQuota === null) {
        md.appendMarkdown(`$(info) *No quota data available*\n\n`);
    }

    // Footer
    md.appendMarkdown(`---\n\n`);
    if (proxyQuotaData.totalAccounts) {
        md.appendMarkdown(`$(server) ${proxyQuotaData.totalAccounts} account(s)\n\n`);
    }
    md.appendMarkdown(`[$(link-external) Open Dashboard](command:antigravity.openDashboard)`);

    return md;
}

function createQuotaBar(percent) {
    const filled = Math.round(percent / 10);
    const empty = 10 - filled;
    const color = percent > 50 ? '🟩' : percent > 20 ? '🟨' : '🟥';
    return color.repeat(filled) + '⬜'.repeat(empty);
}

// ==================== DEACTIVATION ====================

function deactivate() {
    if (pollInterval) clearInterval(pollInterval);
    console.log('[Claude Proxy] Extension deactivated');
}

module.exports = { activate, deactivate };

