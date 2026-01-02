# Antigravity Proxy Status

VS Code extension for Antigravity Claude Proxy - multi-account management and model switching.

## Features

### 🧠 Model Switching
- **Status bar model display** - Shows current model at a glance
- **One-click switching** - Click model name to switch between Flash, Pro, Opus, Sonnet, and more
- **Window-local** - Each VS Code window can have its own model selection

### 👤 Account Management
- **Account status icon** - Shows signed-in accounts in status bar
- **Rich hover tooltip** - View all connected accounts with one hover
- **Quick sign-in** - Sign in with Google, GitHub, or Microsoft
- **Session tracking** - Automatically detects auth changes

### 📊 Dashboard Access
- **One-click dashboard** - Click server icon to open proxy dashboard
- **View quotas** - Check usage limits and reset times

## Status Bar Layout

From left to right:
1. **$(account)** Account icon - Click to manage accounts
2. **Model name** - Click to switch models (shows "Offline" in red when proxy is down)

## Commands

| Command | Description |
|---------|-------------|
| `Antigravity: Switch Model` | Choose a different AI model |
| `Antigravity: Switch IDE Account` | Open IDE account manager |
| `Antigravity: Open Dashboard` | Open proxy dashboard in browser |

## Requirements

- Antigravity Proxy running on `localhost:8080`
- VS Code / Antigravity 1.80.0 or newer

## Installation

```powershell
# From packaged VSIX
antigravity --install-extension claude-proxy-status-2.5.0.vsix
```

Or install from marketplace.

## Publishing

```powershell
./publish.ps1
```

## License

MIT
