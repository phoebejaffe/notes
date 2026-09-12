# AGENTS.md

- Keep [`SPEC.md`](./SPEC.md) updated whenever agents change application behavior, architecture, supported workflows, or product direction. Maintain its `Future improvements` section as work is identified, completed, or reprioritized; consult that section when the user asks what work can be done next.
- When changing behavior specific to the macOS/Tauri app, run `npm run tauri:build` before finishing and report the generated macOS artifacts.
- It is fine to edit files that contain unstaged changes. However, do not fix unrelated "issues" in those edits — they may be another agent's in-progress work. If a fix is needed there, ask the user for permission first.
