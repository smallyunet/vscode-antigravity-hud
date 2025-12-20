# Antigravity HUD

A lightweight VS Code extension for monitoring Google Antigravity AI IDE model usage quota.

## Features

- **Process Detection**: Automatically locates Antigravity editor/Language Server processes
- **Quota Monitoring**: Polls local API for real-time quota information
- **Status Bar Integration**: Minimal `AG: XX%` indicator with color-coded status
- **Quick Details**: Click status bar item for detailed model breakdown

## Status Bar Indicators

| Icon | Meaning |
|------|---------|
| `$(check) AG: 85%` | Good quota remaining (>50%) |
| `$(info) AG: 35%` | Moderate quota (20-50%) |
| `$(warning) AG: 15%` | Low quota (<20%) |
| `$(circle-slash) AG: --` | Not connected |
| `$(sync~spin) AG: ...` | Connecting |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `antigravity-hud.pollingInterval` | `60` | Polling interval in seconds |
| `antigravity-hud.processPatterns` | `["antigravity", "gemini-ls", "gemini-code"]` | Process name patterns to search for |

## Commands

- **Antigravity HUD: Show Quota** - Display detailed quota information
- **Antigravity HUD: Refresh** - Manually refresh connection and quota data

## Development

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Watch mode
npm run watch

# Launch extension in debug mode
# Press F5 in VS Code
```

## How It Works

1. **Process Hunting**: Scans system processes for Antigravity-related processes
2. **Credential Extraction**: Extracts `--api-port` and `--auth-token` from process arguments
3. **API Polling**: Periodically fetches quota data from `http://127.0.0.1:{port}/api/v1/quota`
4. **Status Display**: Shows aggregated quota percentage in status bar

## License

MIT
# vscode-antigravity-hud
