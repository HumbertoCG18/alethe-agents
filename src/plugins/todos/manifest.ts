import type { PluginManifest } from '../../lib/tauri'

export const TODOS_MANIFEST: PluginManifest = {
  id: 'alethe.todos',
  name: 'Todo List',
  version: '1.0.0',
  kind: 'ui',
  apiVersion: 1,
  description: 'A checklist in the right sidebar, with tags and per-project assignment.',
  capabilities: [
    'ui.sidebarTab',
    'ui.command',
    'ui.modal',
    'invoke:ensure_todo_template',
    // Campaigns: reads and watches .workflow/campanhas.json, lists the git worktrees, locates a
    // campaign's handoff file, and writes tasks and states, and the night scheduler's `parou`
    // diary lines, under campanhas.py's lock.
    'invoke:read_text_file',
    'invoke:watch_file',
    'invoke:unwatch_file',
    'invoke:worktree_checkouts',
    'invoke:find_relative_path',
    'invoke:campaign_registry_write',
  ],
  // At startup for the night scheduler, which runs whether or not the tab was opened.
  activation: ['onStartupFinished', 'onView:todos', 'onCommand:todos.reveal'],
  contributes: {
    views: [
      {
        id: 'todos',
        container: 'rightSidebar',
        title: 'Todo',
        titleKey: 'rightSidebar.todoTab',
        panelTitleKey: 'todo.title',
        icon: 'list-todo',
        order: 10,
      },
    ],
    commands: [
      {
        id: 'todos.reveal',
        title: 'Todo list',
        titleKey: 'todo.title',
        icon: 'list-todo',
        keywords: 'todo task checklist list pending',
      },
    ],
  },
  spec: {},
}

export const TODOS_PLUGIN_ID = TODOS_MANIFEST.id
export const TODO_SETTINGS_MODAL_ID = 'todos.settings'
