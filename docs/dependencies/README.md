# Dependency review

[Simplified Chinese version](README.zh-CN.md)

`npm run licenses:check` fails if the lockfile, an installed package's license evidence, or a copied shadcn source changes without review. `inventory.json` records every exact locked artifact, including optional platform archives; `sbom.cdx.json` records the resolved component set. `THIRD_PARTY_NOTICES.txt` preserves the actual license and notice material.

Before adding or upgrading a dependency, inspect the exact release and its transitive tree under the repository policy. Use `npm install --ignore-scripts`, then `npm run licenses:review` to collect actual archive evidence. This command requires registry access and `tar`; it is an evidence generator, not automatic approval. Read its failures, full license texts, bundled notices, and the resulting diff before committing. A missing license file requires release-specific upstream evidence in `upstream-licenses/index.json`; never bypass the gate with an unverified license field.

Some publishers omit license files from npm archives. Supplemental records identify the upstream revision, publisher-linked grant, or same-version parent notice and explain its applicability. The `dlv` notice retains the exact release README's explicit MIT declaration and reproduces standard MIT terms with the release author's attribution. Unknown or incompatible terms remain blocked. Multi-license expressions record the selected permissive branch; all `AND` obligations remain applicable.

Vite 7, Tailwind 3, and Rollup 4.43 are intentionally pinned to avoid unapproved copyleft CSS processing and an unnecessary optional binary with incomplete notice evidence. Do not upgrade these blindly. Copied shadcn Base UI sources come from the official registry; their content fingerprints, source URLs, changes, and pinned upstream MIT text are in `shadcn-sources.json` and `vendor/shadcn/LICENSE`.

Application dependency scanning does not audit an entire operating system. The pinned PostgreSQL image is an upstream development/CI service, not a bundled NexRun application image. GitHub Actions and test browsers run as external development tools. Review their terms and the actual OS/image contents separately before a customer-hosted distribution. Chromium/Chrome and their third-party notices are not redistributed in the web bundle. No production container image is shipped by this sprint.

License checks and SBOMs support review; they do not replace applicable obligations or establish rights to a model service. OpenAI credentials stay server-side, and model access is verified separately from the Pi package license.
