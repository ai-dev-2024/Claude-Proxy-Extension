# Changelog

All notable changes to the Antigravity Proxy Status extension will be documented in this file.

## [3.8.0] - 2026-01-02

### Fixed
- **API Endpoint Mismatch** - Fixed model sync by using correct `/active-model` endpoint instead of non-existent `/set-model`
- Model selection from Claude Code UI now syncs properly to proxy without reverting

### Changed
- Extension now uses POST `/active-model` to communicate with proxy server

## [3.7.0] - 2026-01-02

### Changed
- **Simplified to 2-icon layout** - Removed separate proxy status icon
- Status bar now shows: `$(account)` (IDE account) + Model name (with "Offline" in red)

### Fixed
- Dashboard "UI name may not update" warning now highlighted in yellow
- Clarified `/model flash` command works with CLI only, not extension

## [3.6.0] - 2026-01-02

### Fixed
- **Model Switcher Endpoint** - Fixed `/set-model` to use correct `/active-model` endpoint
- **Model Sync Logic** - Implemented "last change wins" between status bar and Claude Code UI
- **Thinking Block Handling** - Strip thinking blocks from history to prevent "Corrupted thought signature" errors when switching models

### Changed
- Model switches now take effect immediately in the same conversation
- Both status bar and Claude Code UI model selections now work correctly together

### Added
- Dashboard now includes "How Model Switching Works" documentation card

## [3.5.0] - 2026-01-02

### Added
- IDE account switcher with status bar icon
- Multi-account support for Antigravity IDE

## [3.4.0] - 2025-12-31

### Changed
- Updated model switcher UI
- Improved status bar display

## [3.3.0] - 2025-12-31

### Added
- Window-local model switching using workspaceState
- Direct Google OAuth for quota fetching

## [3.0.0] - 2025-12-30

### Added
- Initial release with model switcher and dashboard integration
