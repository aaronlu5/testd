# Third-party notices (web app)

The Testd web app ships only open-source runtime dependencies. This list was produced with
`pnpm licenses list --prod` on 2026-11-12 and covers all 68 production packages: 3 BSD-2/BSD-3,
ISC, MIT and OFL-1.1 licences only. No copyleft licences are present.

## Direct dependencies

| Package                                | Licence | Used for                                  |
| -------------------------------------- | ------- | ----------------------------------------- |
| vue                                    | MIT     | UI framework                              |
| vue-router                             | MIT     | Routing                                   |
| pinia, pinia-plugin-persistedstate     | MIT     | State management and persisted settings   |
| @tanstack/vue-query                    | MIT     | Server-state caching                      |
| @vueuse/core                           | MIT     | Composable utilities                      |
| @vue-flow/core                         | MIT     | Test flow canvas                          |
| ace-builds                             | BSD-3   | Code editor (JSON and SQL, themes, worker)|
| ajv, ajv-formats                       | MIT     | JSON Schema validation of Step parameters |
| clsx                                   | MIT     | Class name helper                         |
| lucide-vue-next                        | ISC     | Icons                                     |
| @fontsource-variable/inter             | OFL-1.1 | Inter variable font (self-hosted)         |
| @fontsource-variable/jetbrains-mono    | OFL-1.1 | JetBrains Mono variable font (self-hosted)|

`@test-platform/contracts` is part of this repository.

## Notes

- The fonts are licensed under the SIL Open Font License 1.1; the licence text ships in each
  font package under `node_modules/@fontsource-variable/*/LICENSE`.
- Ace's editor themes and JSON worker (BSD-3-Clause) are loaded from `ace-builds`; the Vue Flow
  stylesheet (MIT) is the only third-party CSS besides the fonts.
- Transitive packages (Vue's compiler packages, D3 modules used by Vue Flow, Babel parser, and
  others) are MIT, ISC or BSD licensed; run `pnpm --filter @test-platform/web licenses list --prod`
  for the full list.
- Development tools (Vite, Vitest, Playwright, ESLint, Prettier, TypeScript) are not shipped.
