# Contributing to Knowledge

Keep changes focused on Knowledge’s documents, memory, research and access
boundary. Other miniapps and host applications have their own repositories.
Describe the problem, resulting behavior, validation and remaining limitations
in a pull request. Use issues for reproducible non-sensitive bugs and proposals;
never include credentials, customer data or private deployment details.

## Development

Use a supported Node version from `program/package.json` (Node 24 is also
required by the standalone agent adapter). The Program’s pinned package
manager is pnpm 9.15.4. From the repository root:

```sh
corepack pnpm@9.15.4 --dir program install --frozen-lockfile
corepack pnpm@9.15.4 --dir program typecheck
corepack pnpm@9.15.4 --dir program test
corepack pnpm@9.15.4 --dir program build:web
node --test deploy/container/*.test.mjs deploy/container/*.test.ts
```

For agent adapter changes, from `adapters/agent`, run `npm ci` and `npm test`.
The adapter has its own lockfile; do not replace it with the Program’s package
manager. Preserve the bundled engine’s own package manager and lockfile too.
See [runtime fixture reproduction](docs/open-notebook-runtime-validation.md)
and [native memory verification](docs/native-memory-contract.md) for additional
integration checks. Some acceptance scripts require separately installed tools
or provider configuration; report skipped prerequisites explicitly.

Use disposable databases, synthetic content and temporary credentials. Never
point tests at a live customer instance. Distinguish unit/fixture tests from
real provider operations, deployed service checks and human acceptance.

## Security and compatibility

Preserve server-side authorization, partition isolation, audit metadata and
idempotency/reconciliation behavior. Browser identity labels are not authority.
Keep secrets out of browser storage, URLs, logs, screenshots and fixtures.
For suspected vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of
posting exploit details or sensitive material in a public issue.

Document configuration changes, upgrade/recovery requirements and any changed
agent or HTTP contracts. Do not claim a deployment or package publication from
source changes alone. Include upstream attribution and applicable licence
texts for imported code, dependencies, fonts and other assets; record local
changes to bundled upstream components without removing their notices.

Tealbrick’s original code is MIT-licensed. Contributions must be code you have
permission to submit under the applicable licence. Third-party material keeps
its original terms; discuss incompatible dependencies before adding them.
