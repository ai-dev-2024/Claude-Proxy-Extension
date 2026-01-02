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
1. **👤** Account icon - Click to manage accounts
2. **$(server)** Proxy status - Click to open dashboard  
3. **Model name** - Click to switch models

## Commands

| Command | Description |
|---------|-------------|
| `Antigravity: Switch Model` | Choose a different AI model |
| `Antigravity: Switch Account` | Manage signed-in accounts |
| `Antigravity: Add Account` | Sign in with a new account |
| `Antigravity: Refresh Account Status` | Reload account list |
| `Antigravity: Open Dashboard` | Open proxy dashboard in browser |
| `Antigravity: Show Current Model` | Display current model info |

## Requirements

- Antigravity Proxy running on `localhost:8080`
- VS Code 1.80.0 or newer

## Installation

```powershell
# From packaged VSIX
code --install-extension claude-proxy-status-3.0.0.vsix
```

Or install from marketplace.

## Publishing

```powershell
./publish.ps1
```

## License

MIT
