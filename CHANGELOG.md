# Changelog — Antigravity Proxy Status Extension

All notable changes to the VS Code extension will be documented in this file.

---

## [3.9.2] - 2026-01-02

### Added
- **Smart Account Sorting** - Accounts with highest Claude quota shown first
- **Click-to-View Quota Popup** - Quick Pick popup shows all quota info on click
- **Clean UI Labels** - Removed icon prefixes from separator labels

### Changed
- Status bar shows just `$(account)` icon (no email text)
- Accounts sorted by Claude availability for easy manual switching

---

## [3.9.0] - 2026-01-02

### Added
- **Quota Info Panel** - Dedicated panel with real-time quota updates
- **Antigravity Account Detection** - Fetches logged-in account from IDE
- **Visual Quota Bars** - Block characters (▰▱) for quota display

### Changed
- Improved quota data processing with per-model breakdown

---

## [3.8.0] - 2026-01-02

### Added
- **Multi-Account Quota Display** - Shows quotas for all connected Google accounts
- **Reset Time Display** - Shows when each account's quota resets
- **Per-Model Quotas** - Claude and Gemini quotas displayed separately

---

## [2.6.0] - 2026-01-02

### Added
- **Per-Model Quota Display**: Hover tooltip shows Claude and Gemini quotas separately
- **Model-Level Breakdown**: Shows individual model quotas (opus, sonnet, flash, pro)
- **Visual Quota Bars**: Color-coded based on remaining percentage

### Removed
- **IDE Account Switcher**: Removed unused Antigravity IDE account feature

---

## [2.5.0] - 2026-01-02

### Added
- **Simplified 2-Icon Layout**: Account icon + Model name

### Fixed
- **API Endpoint Mismatch**: Fixed model sync using `/active-model` endpoint

---

## [2.4.0] - 2026-01-02

### Added
- **Dashboard Auto-Refresh Polling**: Extension syncs after OAuth operations

---

## [2.3.0] - 2026-01-01

### Added
- **Window-Local Model Switching**: Per-window model memory
- **Direct Google OAuth**: Quota fetching support

---

## [2.2.0] - 2026-01-01

### Added
- **Faster Polling**: 2-second interval for quick updates
- **Offline Detection**: 2-second timeout shows "Offline" immediately

---

## [2.1.0] - 2026-01-01

### Added
- **Status Bar Sync**: Updates to show actual model from Claude dropdown

---

## [2.0.0] - 2026-01-01

### Added
- **Real-Time Model Display**: Shows current model with emoji icons
- **3-Second Polling**: Auto-updates from `/active-model` endpoint
- **Dashboard Integration**: Click status bar to open dashboard
