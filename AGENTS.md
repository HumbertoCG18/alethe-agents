# Alethe — working guide (AI)

> Single source of agent instructions: `CLAUDE.md` only imports this file, and Codex and
> Antigravity read it directly. Contributing from outside? Start with
> [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, project layout, house rules, and PR convention.

## 1. What it is

**Alethe** is a **Windows-first** desktop app that organizes, operates, and resumes multiple coding
agents (Claude Code, Codex, OpenCode) and shells in parallel, inside a persistent workspace with
real terminals (PTYs), layouts, themes, history, and RAM control.

> Tagline: **Reveal the state of every agent, shell, and project.**
> Status: functional MVP in polish. Identifier: `com.kc1t.alethe`.

## 2. Commands (from `package.json`)

```powershell
npm install
npm run app      # = tauri dev — runs the full app with hot reload (RECOMMENDED WAY)
npm run dev      # Vite frontend only, at http://localhost:1422 (strictPort)
npm run build    # tsc + vite build — tsc typechecks and VALIDATES i18n (see §3)
npm test         # vitest run over src/**/*.test.{ts,tsx}
```

Building the Windows installer (MSI/NSIS): follow `.claude/skills/building-windows-installer/SKILL.md`.

## 3. Non-negotiable rules

1. **DO NOT stop or restart the app or the dev server** (`tauri dev` / Vite). Do not kill the
   process, do not run `npm run app` "just to test" if it is already running. Apply changes through
   **HMR** and trust the reload.
2. **DO NOT commit / push / tag / release without explicit permission from the owner at that
   moment.** Make changes **in the working tree only** and stop — committing is his call. When he
   authorizes a commit, **DO NOT add a co-author** (`Co-Authored-By: Claude …`) or any tool
   signature to the message — he is the only author.
3. **Strict design system — no gradients, nothing "vibecoded".** No generic template UI. Dashboards
   and widgets show **real data**, never placeholder/mock. Style through CSS Modules + tokens from
   `src/styles/theme.css`; **never** hardcode a color — use the variables (`--bg`, `--fg`,
   `--accent`, `--agent-*`, `--status-*`, etc.).
4. **i18n is mandatory.** Every visible string goes through `t()`. When adding text, register the key
   in `src/lib/i18n/messages/en.ts` (**source of truth**, default EN) **and** in every other
   locale: `src/lib/i18n/messages/pt-BR.ts` and `src/lib/i18n/messages/zh-CN.ts`. Each is typed
   against the keys of `en.ts`, so `npm run build` **fails** if a translation is missing.
5. **Changelog is mandatory for features.** Every feature addition, change, or removal must update
   [`docs/CHANGELOG.md`](docs/CHANGELOG.md) in the same task, under the **`[Unreleased]`** section
   (top of the file), with a short, objective, user-facing description. Never skip this step — the
   changelog is the source for release notes.

## 4. Area rules

Read the matching file before editing that area. Claude Code loads them on its own when it touches a
matching file.

- `src/` (React frontend): [`.claude/rules/frontend.md`](.claude/rules/frontend.md) — CSS Modules,
  domain types, Zustand, `projects.json` debounce and migration, input validation before spawning.
- `src-tauri/` (Rust backend and Tauri config): [`.claude/rules/tauri.md`](.claude/rules/tauri.md)
  — CSP, `spawn_pty`, OAuth tokens, atomic writes, local data, Windows toolchain.

The frontend calls `invoke(...)` through `src/lib/tauri/`; the terminal receives streaming through
the Tauri events `pty://data/{id}` and `pty://exit/{id}`.

## 5. Docs

[`CONTRIBUTING.md`](CONTRIBUTING.md) (setup per OS, layout, domain glossary, commit/PR convention)
and `docs/`: `FEATURES.md` (features in detail), `CHANGELOG.md`, `OVERVIEW.md` (domain model,
stack, persistence), `BRAND.md`, `PLUGINS.md` (plugin manifest, capabilities, lifecycle, adding a
bundled plugin), `THEMES.md` (adding a theme), `DIAGNOSTICO_MATURIDADE_TECNICA.md` (code
organization, duplication and performance diagnostic).

## Language and comment rules

- English is the default language for all versioned repository content, including source comments,
  JSDoc, documentation, changelog entries, user-facing strings, commit messages, and pull requests.
- Never add Portuguese prose to source comments, JSDoc, internal logs, or documentation. Translate any
  non-English comment encountered in a file being changed.
- Use another language only when the target file explicitly requires it. Locale files are the standard
  exception: translated UI text belongs in the matching locale file.
- When editing existing mixed-language content, translate the touched content to English when practical
  instead of extending the language inconsistency.
- Keep comments concise. Add them only when they explain non-obvious behavior, constraints, or decisions.

This project has a knowledge graph at `graphify-out/`. For codebase-structure questions
(architecture, god nodes, cross-file relationships), use the `graphify-query` skill instead of
raw grep/source browsing.
