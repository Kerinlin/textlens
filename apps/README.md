# Flick Platform Apps

Flick keeps one shared Tauri, Rust, and React codebase. The `apps` directory only owns platform-specific code, assets, and release checks.

Current layout:

- `macos/`: native selection bridge, tray and icon assets, and macOS artifact verification.
- `windows/`: Windows selection backend, startup notice renderer, Windows icon assets, and Windows artifact verification.

Shared code stays outside `apps`:

- `src/shared/`: cross-platform schemas, defaults, action data, and URL helpers.
- `src/renderer/`: shared toolbar, result, settings UI, and the thin startup build entry.
- `src-tauri/src/`: shared runtime, window coordination, model requests, settings, and platform facades.
- `src-tauri/tauri.conf.json`, `src-tauri/tauri.windows.conf.json`, and `src-tauri/build.rs`: build entry files that reference the platform sources in `apps/`.
