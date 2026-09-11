# AGENTS.md

- Keep [`SPEC.md`](./SPEC.md) updated whenever agents change application behavior, architecture, supported workflows, or product direction. Maintain its `Future improvements` section as work is identified, completed, or reprioritized; consult that section when the user asks what work can be done next.
- When changing behavior specific to the macOS/Tauri app, run `npm run tauri:build` before finishing and report the generated macOS artifacts.
