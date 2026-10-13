---
paths:
  - "src/**"
---

# Frontend (`src/`)

- One `.module.css` file per component; color and spacing always through tokens, never literals.
- New domain types go in `src/lib/types.ts`; reuse the existing ones.
- Lean Zustand selectors to avoid rerender loops.
- `projects.json` is saved with debounce from the store; its schema is versioned with
  migration/backfill — when changing its shape, keep the migration.
- `spawn_pty` runs a shell with the command/args coming from the frontend — **validate input on the
  frontend** before spawning.
- Treat any rendered input as untrusted; the webview has full IPC access.
