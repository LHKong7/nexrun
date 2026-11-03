# NexRun Project Instructions

## Language conventions

- Use English as the primary development and product language; provide Simplified Chinese (`zh-CN`) as the secondary language.
- Write identifiers, filenames, code comments, API contracts, error codes, diagnostic logs, test descriptions, and developer-facing tooling in English.
- Author the primary README, architecture documentation, contributor instructions, commit messages, and PR descriptions in English. Provide Chinese companion documentation where useful and keep shared technical facts consistent.
- For bilingual documentation, maintain separate complete English and Simplified Chinese files (for example, `architecture.md` and `architecture.zh-CN.md`) with reciprocal links and equivalent coverage. Do not mix English prose with Chinese summaries or treat a summary as the Chinese edition. Update both editions together when changing shared content; preserve code and protocol identifiers.
- Use English (`en`) as the default UI locale and translation fallback. Keep user-facing strings in translation resources, with matching English and Simplified Chinese keys; preserve a user's explicit locale selection.
- Localize user-facing errors and approval text through stable codes and parameters. Do not translate code, commands, paths, protocol fields, or raw CLI output in place.
- Keep the Agent response language configurable independently of the UI locale. Preserve the original text of user prompts and repository content.
- Follow the user's language in conversation; these project conventions do not require switching Chinese discussions to English. Honor explicit language requests for individual deliverables.

## Commercial use and third-party dependency admission

The user requires every third-party library introduced into this project to permit the project's commercial use. Apply this requirement during initialization, development, upgrades, and releases.

### Default selection criteria

- Support paid cloud services and, by default, preserve the option to deploy and distribute application code as closed source. Do not change the existing project LICENSE as a substitute for reviewing third-party rights.
- Prefer permissive application-library licenses such as MIT, Apache-2.0, ISC, BSD-2-Clause, and BSD-3-Clause. Still verify the exact version, bundled code, and notice obligations.
- Do not introduce components with missing or unknown licenses, noncommercial/research-only restrictions, or restrictions incompatible with the project's actual commercial use.
- GPL, AGPL, LGPL, and MPL do not prohibit commercial use, but copyleft application dependencies are not admitted by default. Prefer permissive alternatives. If an exception is necessary, explain the usage, obligations, and compatibility, then obtain the user's explicit agreement to that exception.
- Review SSPL, RSAL, BUSL-1.1, Commons Clause, proprietary licenses, and custom terms individually; they are not admitted by default. Do not confuse BUSL-1.1 (Business Source License) with BSL-1.0 (Boost Software License).
- Record the chosen authorization path for dual/multiple licenses. Satisfy every obligation in SPDX `AND` expressions, identify an applicable path for `OR`, and review `WITH` together with its specific exception.

### Every addition and upgrade

1. Inspect the actual package, exact version, release artifacts, LICENSE, NOTICE, copyright information, and upstream source. An npm `license` field or repository homepage alone is insufficient evidence.
2. Cover direct, transitive, development, optional, and native dependencies; binaries fetched by install scripts; and frontend bundles. Assets, fonts, icons, and copied snippets also require authorization evidence.
3. Commit lockfiles, pin release-image digests, and use reproducible installation. Recheck changes for upgrades, image replacements, and additional downloads. A development branch's license does not establish the selected release's license.
4. Record version/digest, source, SPDX identifier or terms, chosen license, usage/distribution model, required obligations, review date, and conclusion in the dependency inventory.
5. Preserve required copyright and license text. Supply THIRD_PARTY_NOTICES, modification notices, corresponding source, or other materials when required. Permissive licenses still carry obligations.
6. Choose an alternative when compatibility is unresolved or obligations cannot be fulfilled. Do not release first and review later.

### Infrastructure and CLI Agents

- Audit databases, caches, workflow engines, hosts, container base images, and sandbox system packages separately. Do not categorically label independent Linux, Git, or Bash components as noncommercial because of GPL. Evaluate execution, modification, linking, and distribution obligations, especially for customer-hosted images.
- Evaluate Valkey as the default cache candidate instead of the previously proposed Redis without a specified version. Review the selected version, clients, modules, bundled dependencies, and images separately.
- Review CLI binaries, SDKs, model/API services, hosted sandboxes, and trademarks separately. An open-source SDK license does not authorize CLI hosting/modification/resale or resale of model usage. BYOK does not waive service terms.
- Check Claude Code's official hosting conditions: preserve the published binary and native authentication methods; end users use their own valid credentials and pay for their own usage. Do not default to platform-funded/resold inference or collecting Claude.ai session tokens.
- Do not automatically extend platform license findings to user-imported repositories or third-party content generated or introduced by Agents.

### Implementation and release gates

- Implement direct/transitive license checks when initializing package management and CI. Unknown, unreviewed, or policy-incompatible changes must fail the checks.
- Generate a release-specific SBOM and third-party notices. Audit actual deliverables, including extra installation downloads. Separately review system-component distribution obligations for customer-hosted releases.
- Scanners and SBOMs provide evidence and engineering gates, not automatic legal conclusions. Vulnerability scanners such as npm audit are not license reviews. Do not claim that unimplemented CI gates are active.
- At policy creation, the repository had no package.json, lockfile, or deployment image. These rules do not establish that the proposed stack has passed an exact-version audit.

### Sources checked on 2026-11-03

- MIT: https://opensource.org/license/mit
- Apache-2.0: https://www.apache.org/licenses/LICENSE-2.0
- Redis version-specific licenses: https://redis.io/legal/licenses/
- Valkey main-project license: https://github.com/valkey-io/valkey/blob/unstable/COPYING (check the selected release when adopting it)
- Claude Code hosting and authentication terms: https://code.claude.com/docs/en/legal-and-compliance
