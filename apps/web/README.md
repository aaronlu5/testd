# Testd web UI

The browser front end of Testd: author Tests and Test Data, configure Environments and secrets,
launch Runs and Suites, and follow them live (including pausing at Breakpoints).

Vue 3, TypeScript, Pinia, Vue Router and TanStack Query, built with Vite. The interface is original
to this project: plain CSS design tokens, a small in-house component kit and Lucide icons. There is
no CSS framework or admin template.

## Run it

From the repository root, `pnpm dev` starts the API, the worker and this app on
<http://127.0.0.1:5173>. To work on the UI alone, run `pnpm --filter @test-platform/web dev`
against an API at `VITE_API_BASE_URL` (default `http://127.0.0.1:3000`; see `.env.example`).

## Checks

```sh
pnpm --filter @test-platform/web typecheck
pnpm --filter @test-platform/web lint:check
pnpm --filter @test-platform/web format:check
pnpm --filter @test-platform/web test          # Vitest unit and component tests
pnpm --filter @test-platform/web build
pnpm --filter @test-platform/web test:e2e      # Playwright; build first, see the root README
```

## Layout of `src`

| Path                      | What lives there                                                        |
| ------------------------- | ----------------------------------------------------------------------- |
| `styles/`                 | Design tokens (`--td-*`), base styles, utilities, form control styles    |
| `components/ui/`          | The `Ui*` component kit (buttons, dialogs, dropdowns, form controls ...) |
| `components/platform/`    | Testd components: flow canvas, step inspector, editors, status badges    |
| `layouts/`                | App shell: top bar, side menu, page shell, quick search                  |
| `views/platform/`         | One folder per page (tests, runs, suites, environments, secrets ...)     |
| `api/`, `stores/`         | API client and queries, Pinia stores                                     |
| `router/`                 | Routes (paths, names and titles are stable; tests rely on them)          |

## Design system

- **Tokens:** `styles/tokens.css` defines colour, type, spacing, radius, motion and z-index
  variables. Dark is the default; `data-theme="light"` on `<html>` switches theme, and the choice
  (system, light or dark) is saved in local storage.
- **Components:** every `Ui*` component is keyboard operable and labelled; dialogs and drawers trap
  focus and close on Escape. Prefer them to ad-hoc markup.
- **Icons:** add new icons in `components/ui/icons.ts` so only the glyphs in use are bundled.
- **Fonts:** Inter and JetBrains Mono (variable, Latin and Latin Extended), self-hosted.

## Conventions

- Keep `data-testid` values and route names stable; the unit and end-to-end tests use them.
- Fill code-editor (Ace) fields in end-to-end tests with `replaceEditorText()` from
  `e2e/helpers.ts`, because Playwright's `fill()` only inserts at the cursor in Ace.
- Third-party licences are listed in `THIRD_PARTY_NOTICES.md`.
