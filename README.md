# Antigravity Proxy Status

VS Code extension for Antigravity Claude Proxy - real-time quota monitoring, multi-account management, and instant model switching.

![Quota Popup](screenshot-quota-popup.png)

## ✨ Key Features

### 📊 Real-Time Quota Monitoring
- **Click to view quotas** - Click the account icon to see Claude & Gemini quota status
- **Per-model breakdown** - See individual quotas for Opus, Sonnet, Flash, Pro
- **Reset time display** - Know exactly when your quota resets
- **Smart account sorting** - Accounts with highest Claude quota shown first (helps when manually switching Antigravity accounts)

### 🧠 Instant Model Switching
- **One-click switching** - Click model name in status bar to switch models
- **Supported models**: Flash ⚡, Pro 💎, Opus 🎭, Sonnet 🎵, Grok 🌐, Perplexity 🔍
- **Instant sync** - Model changes sync immediately with proxy

![Model Switcher](screenshot-model-switcher.png)

### 👤 Status Bar Integration
- **Account icon** - Shows proxy connection status
- **Model display** - Current model with emoji indicator
- **Offline detection** - Shows "Offline" in red when proxy is down

![Status Bar](screenshot-statusbar.png)

## Status Bar Layout

| Icon | Description | Click Action |
|------|-------------|--------------|
| 👤 | Account/Quota | Opens quota popup with all accounts |
| 💎 Pro | Current model | Opens model switcher |

## Quota Popup Features

When you click the account icon:

1. **Model Quotas** - Overall Claude and Gemini percentages with visual bars
2. **Google Accounts** - All connected accounts sorted by Claude availability
3. **Reset Times** - Shows when each account's quota resets
4. **Open Dashboard** - Quick link to full proxy dashboard

## Commands

| Command | Description |
|---------|-------------|
| `Antigravity: Switch Model` | Choose a different AI model |
| `Antigravity: Open Dashboard` | Open proxy dashboard in browser |

## Requirements

- Antigravity Proxy running on `localhost:8080`
- VS Code / Antigravity 1.80.0+

## Installation

### From Open VSX (Recommended)
Search "Antigravity Proxy Status" in extensions marketplace.

### From VSIX
```powershell
antigravity --install-extension claude-proxy-status-3.9.2.vsix
```

## Advanced Features

- **Auto-account rotation** - Proxy automatically switches to next account when quota exhausted
- **Multi-account support** - Connect unlimited Google accounts via dashboard
- **Visual quota bars** - Color-coded (filled/empty blocks) for quick status reading
- **Instant polling** - 5-second refresh for real-time quota updates

## License

MIT
