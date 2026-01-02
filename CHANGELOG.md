# Changelog — Antigravity Proxy Status Extension

All notable changes to the VS Code extension will be documented in this file.

---

## Version Alignment

The extension version matches the proxy version for easier tracking:
- Extension **v2.x** = Proxy **v2.x** (Extension + Proxy era)

---

## [2.6.0] - 2026-01-02

### Added
- **Per-Model Quota Display**: Hover tooltip shows Claude and Gemini quotas separately
- **Model-Level Breakdown**: Shows individual model quotas (opus, sonnet, flash, pro)
- **Visual Quota Bars**: Color-coded (🟩/🟨/🟥) based on remaining percentage

### Removed
- **IDE Account Switcher**: Removed unused Antigravity IDE account feature
- Status bar no longer shows account email

### Changed
- Status bar icon now shows `$(graph)` instead of `$(account)`
- Tooltip redesigned to focus on quota information

---

## [2.5.0] - 2026-01-02

### Added
- **IDE Account Switcher**: `$(account)` icon in status bar to manage Antigravity IDE accounts
- **Simplified 2-Icon Layout**: Account icon + Model name (shows "Offline" in red when proxy down)

### Fixed
- **API Endpoint Mismatch**: Fixed model sync by using correct `/active-model` endpoint
- Model selection from Claude Code UI now syncs properly to proxy without reverting

---

## [2.4.0] - 2026-01-02

### Added
- **Dashboard Auto-Refresh Polling**: Extension syncs with proxy after OAuth operations

### Changed
- Extension uses POST `/active-model` to communicate with proxy server

---

## [2.3.0] - 2026-01-01

### Added
- **Window-Local Model Switching**: Uses `workspaceState` for per-window model memory
- **Direct Google OAuth**: Quota fetching support

### Changed
- Updated status bar display for multi-window support

---

## [2.2.0] - 2026-01-01

### Added
- **Faster Polling**: 2-second interval for quick status bar updates
- **Offline Detection**: 2-second timeout shows "Offline" immediately

### Changed
- Improved extension connection retry logic (1-second delays)

---

## [2.1.0] - 2026-01-01

### Added
- **Status Bar Sync**: Updates to show actual model being used from Claude dropdown
- **Model Priority Display**: Shows dashboard model when Claude UI is set to "Custom"

### Fixed
- Status bar not updating when switching models via Claude Code dropdown

---

## [2.0.0] - 2026-01-01

### Added
- **Real-Time Model Display**: Shows current model with emoji icons (⚡💎🎭🎵)
- **3-Second Polling**: Auto-updates from `/active-model` endpoint
- **Model Change Notifications**: Toast notification when model changes via dashboard
- **Dashboard Integration**: Click status bar to open dashboard

### Changed
- Now shows current model name instead of static "Claude Proxy" text

