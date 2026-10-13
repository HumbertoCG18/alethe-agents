---
paths:
  - "src-tauri/**"
---

# Backend and Tauri config (`src-tauri/`)

- `tauri.conf.json` ships a strict CSP (`script-src 'self'`, `worker-src 'none'`), asserted literally
  by `src/securityPolicy.test.ts`. Any change there is a deliberate, reviewed one. Treat any
  rendered input as untrusted; the webview still has full IPC access.
- `spawn_pty` runs a shell with the command/args coming from the frontend; the frontend validates
  that input before spawning.
- OAuth tokens (Spotify, Claude) are stored in **plaintext** in app data; do not log or expose them.
- `projects.json` and the other app data files are written atomically (tmp → rename) — preserve that
  pattern.
- Local data: `%APPDATA%/Alethe/` (profiles, `projects.json`, scrollback `*.bin`, `spawn.log`).
- The Rust toolchain on `C:` can be corrupted by Windows Defender — prefer building from `D:`.
  Installer builds: `.claude/skills/building-windows-installer/SKILL.md`.
