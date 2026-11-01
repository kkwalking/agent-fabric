# AgentFabric

> **Run any agent, on any model, in any environment.**

AgentFabric is an open-source agent runtime orchestration platform. It does not define how an agent should think; it supplies the shared infrastructure for providers, models, agent runtimes, workspaces, tasks, runs, native sessions, artifacts and observability.

This system is built from the product it names: the palette and type come from `packages/web/src/style.css`, and the mark is the repository's real `assets/AgentFabric-logo.svg`. The product UI is light-first; the dark theme is derived from the logo tile for covers, keynotes and embedded dark surfaces. Nothing here approximates or redraws the mark.

## Content fundamentals

- **Speak in capabilities, not adjectives.** Name the object and the action: “one workspace, five local runtimes”, not “revolutionary agent experience”.
- **Keep the product name as one word.** AgentFabric, never “Agent Fabric” or “AF” in body copy. The short form is reserved for the compact mark.
- **Use the vocabulary of the system.** Provider, Model, Runtime, Workspace, Task, Run, Harness, Native Session. A workspace is a directory; a run is one execution; a runtime is a place to run, not a property of the workspace.
- **Say what is absent.** The absence of a project layer, clone, branch and publish policy is a product decision. State it directly.
- **Chinese product copy is concise and technical.** Prefer short declarative sentences. Keep product nouns in English where the UI does. Avoid hype, magic and anthropomorphism.
- **Numbers need a source.** “5 local harness adapters”, “4-column Kanban”, “local-only loopback API” are facts from the repository. Do not invent percentages or benchmarks.
- **One call to action per page.** The primary action is dark ink; the warm accent marks the one thing to notice.

## Visual foundations

**Canvas.** White is the default surface. The product is quiet and dense: thin `#e8e8e6` hairlines, 12px card corners, and a single low shadow. Dark surfaces belong to the logo tile and to key moments, not every page.

**Colour.** The identity is a woven three-strand mark: cyan, warm orange and violet on a deep navy tile. In the interface, the working accent is a single burnt orange (`#e2620e`) used sparingly. Status colours are functional only — blue for information, green for success, red for failure, yellow for pending, purple for review. Never use the three brand thread colours as a decorative gradient wash.

**Type.** One sans family (SF Pro / PingFang SC on macOS) with a mono companion. Display type is tight and plain-spoken: heavy weight, negative tracking, no outline or gradient fill. Body copy stays at 16px on slides; UI detail may step down to 13.5px. Uppercase labels are short, tracked and never whole sentences.

**Layout.** Use a 12-column grid with 96px outer margins on a 1600×900 canvas. Left-align text. Let diagrams breathe in the right 7–8 columns; keep the argument in the left 4–5. A thin rule above a section label is enough structure; boxes inside boxes are noise.

**Shape and material.** Soft rectangles, one pill. Cards use a 12px radius and a hairline; buttons use 8px. The composer uses a 22px radius because it is a single large input, not a card. Shadows only explain elevation; flat surfaces stay flat.

**Motion.** If motion is used, it is a single 160–240ms ease for a state change. No floating, pulsing or looping decoration.

## Iconography

The product uses compact line icons with a consistent 1.5px stroke, round caps and a 24px frame. Icons are functional labels, not illustrations. The AgentFabric mark is the only multi-colour graphic; do not tint it, outline it or place it on a busy photograph. Do not use emoji as interface icons.

## Using the system

- Read `tokens.json` for exact values; use token names in implementation notes.
- Use `accent` for one emphasis per view. If a layout needs two accents, one of them is probably a status colour.
- Pair `ink` on `surface` or `surface-raised`; pair `on-accent` on `accent`. Never put `ink-muted` on `surface-sunken` for long body copy.
- The dark theme is for covers and full-bleed moments. Body slides remain light unless the content is a single statement.
- The logo asset is `assets/Logos/AgentFabric-logo.svg` (uploaded, referenced by id in previews). Keep clear space equal to the tile's corner radius.

## Source map

| What | Where |
| --- | --- |
| Interface palette, type stack, radii and shadows | `packages/web/src/style.css` |
| Product mark and woven strand geometry | `assets/AgentFabric-logo.svg`, `packages/web/src/brand.tsx` |
| Product vocabulary and capability inventory | `README.md` |
| Deck use | `designs/agentfabric-product-deck/` |


---

## Consuming this system (generated — do not edit)

Every path named below is under `project/` in this design system: read `project/api/tokens.md`, not `api/tokens.md`.

`components/bundle.js` defines `window.AgentFabricDS` (3 components); `components/bundle.css` is its stylesheet; `tokens.css` is every token as a CSS variable plus `@font-face` for the fonts. `components/bundle.css` reads its variables from `tokens.css`. Build any UI by mounting these components; never hand-build a control or draw an icon the system provides.

- **Standalone page:** inline `tokens.css` and `components/bundle.css` in a `<style>`, then `components/bundle.js` as a classic script (a file containing `</style`, `</script` or `<!--` breaks an inline element: write the sequence `<\/style`, `<\/script` or `\x3C!--` in your copy, or load that file by URL).
- **Design canvas:** bring `components/bundle.css`, `components/bundle.js` and `components/index.d.ts` (for the editor’s props panel) onto the canvas in full, as the canvas type’s design-system components reference says (a server-side copy first where it offers one); load the stylesheet before the script; mount with `<x-import component-from-global-scope="AgentFabricDS.<Comp>" …>`.
- **Slides deck, or any surface that cannot run the bundle:** tokens only — the values are on `api/tokens.md`; the deck takes `tokens.json` by file path for its colour pickers.

**Read, per thing:** a component’s props, parts and examples: `api/components/<Comp>.md`; token values: `api/tokens.md`; stored assets and their paths: `api/assets/<Group>.md`. After this README, fetch the cards and fonts you need in ONE message as parallel calls — none depends on another.

**Two rules.** Before you use a thing — a component, a token group, an icon, an asset — read its card from the index below; a value you did not read from a card is a guess. `tokens.json`, `manifest.json`, `components/index.d.ts` and `design-system.json` are sources for tools: hand them over. `components/<Comp>/README.md` and `assets/<Group>/README.md` are the long-form second read a card links to; the `design-system` skill is authoring guidance, not needed to consume the system.

## Index (generated — do not edit)

**Tokens**

- `api/tokens.md` — Every token: surface, text, fill, palette, type, spacing, radius, shadow. (6.9k)

**Icons and assets**

- `api/assets/Logos.md` — 1 file, by asset id. (1.3k)

**Components** (`api/components/<Comp>.md`, 3)

- **Actions**: `Button` — The product has one button shape
- **Status**: `Badge` — A compact status pill with a 6px dot
- **Surfaces**: `Card` — The default surface for a task, board card or settings group: white, hairline border, 12px radius and one low shadow
