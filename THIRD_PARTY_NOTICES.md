# Third-party notices

Flick independently implements its application and native selection-capture code. It does not copy Cherry Studio branding, icons, CSS, or other visual assets. The limited Cherry Studio-derived prompt material is identified below.

## Cherry Studio default AI action prompts

- Project: <https://github.com/CherryHQ/cherry-studio>
- Source revision: `900e928543892c2ad050fdd9da45e43f4c429519`
- License: GNU Affero General Public License v3.0 — <https://github.com/CherryHQ/cherry-studio/blob/900e928543892c2ad050fdd9da45e43f4c429519/LICENSE>
- Usage: the default translation prompt, the Simplified Chinese selection-summary, explanation, and refinement prompts, and their placeholder-expansion behavior were adapted from Cherry Studio.
- Source files: [`src/shared/ai/prompts.ts`](https://github.com/CherryHQ/cherry-studio/blob/900e928543892c2ad050fdd9da45e43f4c429519/src/shared/ai/prompts.ts#L52-L53), [`src/renderer/i18n/locales/zh-cn.json`](https://github.com/CherryHQ/cherry-studio/blob/900e928543892c2ad050fdd9da45e43f4c429519/src/renderer/i18n/locales/zh-cn.json#L5201-L5204), and [`ActionGeneral.tsx`](https://github.com/CherryHQ/cherry-studio/blob/900e928543892c2ad050fdd9da45e43f4c429519/src/renderer/windows/selection/action/components/ActionGeneral.tsx#L53-L79).

Flick fixes one duplicated punctuation mark in the refinement prompt and expresses Cherry Studio's summary/explanation text concatenation as an explicit `{{text}}` placeholder. Flick's custom-action default prompt remains independently authored. This notice does not alter or replace the upstream AGPL-3.0 terms applicable to the adapted material.

## selection-hook 2.0.2

- Project: <https://github.com/0xfullex/selection-hook/tree/v2.0.2>
- License: MIT
- Usage: portions of the macOS selection implementation were adapted into the native C ABI bridge under `apps/macos/native`.

The full upstream copyright and MIT license notice is reproduced verbatim in `LICENSE.selection-hook`. That file and this attribution must be retained when source or binary distributions contain the adapted implementation.

## Direct application dependencies

Flick also uses independently developed software, including:

- Tauri 2 — Apache-2.0 OR MIT — <https://github.com/tauri-apps/tauri>
- React and React DOM — MIT — <https://github.com/facebook/react>
- dnd kit — MIT — <https://github.com/clauderic/dnd-kit>
- Lucide — ISC — <https://github.com/lucide-icons/lucide>
- react-markdown — MIT — <https://github.com/remarkjs/react-markdown>
- remark-gfm — MIT — <https://github.com/remarkjs/remark-gfm>
- remark-math and rehype-katex — MIT — <https://github.com/remarkjs/remark-math>
- KaTeX — MIT — <https://github.com/KaTeX/KaTeX>
- Zod — MIT — <https://github.com/colinhacks/zod>
- reqwest — MIT OR Apache-2.0 — <https://github.com/seanmonstar/reqwest>
- Tokio — MIT — <https://github.com/tokio-rs/tokio>
- serde — MIT OR Apache-2.0 — <https://github.com/serde-rs/serde>
- ring — ISC, MIT, and OpenSSL licenses — <https://github.com/briansmith/ring>
- base64 — MIT OR Apache-2.0 — <https://github.com/marshallpierce/rust-base64>
- objc2 — MIT — <https://github.com/madsmtm/objc2>
- macos-accessibility-client — Apache-2.0 — <https://codeberg.org/fresskoma/macos-accessibility-client>
- windows-rs — MIT OR Apache-2.0 — <https://github.com/microsoft/windows-rs>
- tauri-plugin-global-shortcut — Apache-2.0 OR MIT — <https://github.com/tauri-apps/plugins-workspace>
- tauri-plugin-single-instance — Apache-2.0 OR MIT — <https://github.com/tauri-apps/plugins-workspace>

These projects have their own copyright notices, license texts, and transitive dependencies. Before a public release, generate and review a complete inventory from the resolved `pnpm-lock.yaml` and `src-tauri/Cargo.lock`; retain every notice required by the corresponding license.
