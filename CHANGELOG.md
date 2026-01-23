# Changelog

All notable changes to this project will be documented in this file.

## [0.2.4] - 2026-01-23

### Changed
- **Behavior**: Removed unreliable "active model" auto-detection. The status bar now shows the monitored model (if selected) or the lowest quota across models.
- **Reliability**: Improved connection status messaging so retry reasons are reflected in the UI immediately.
- **Performance**: Throttled statistics persistence to reduce frequent `globalState` writes.
- **Logging**: Normalized quota parsing logs (no more `console.*` in core parsing).

### Added
- **Commands**: Reset statistics and clear monitored model selection.

## [0.1.0] - 2025-12-23

### Changed
- **Refactor**: Extracted quota parsing logic into a dedicated, testable module.
- **Project Structure**: Added unit tests for core logic.

### Added
- **Features**: Restored Open VSX support.
- **Docs**: Enhanced README with new badges and improved layout.

## [0.0.6]

### Added
- Initial release details...
