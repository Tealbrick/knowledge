# Optional Portal authentication for Research

Knowledge can accept Portal-authenticated requests on its protected Research
engine routes through a trusted construction option. This does not unify
authentication across Knowledge: legacy Documents, Brain, and local Research
CRUD remain outside this adapter.

The ordinary `program/src/index.ts` entrypoint does **not** enable this provider.
There is no environment-variable switch. A deployment host must explicitly
construct and inject the provider. The host supplies `@tealbrick/portal`; the
Knowledge helper has a structural verifier interface and does not import a
sibling repository or add a package dependency.

## Trusted construction

```ts
import { createPortalVerifier } from '@tealbrick/portal';
import { buildKnowledgeApp } from './program/src/app.js';
import { createPortalResearchPrincipalProvider } from './program/src/portal-research-principal.js';

const researchPrincipalProvider = createPortalResearchPrincipalProvider({
  audience: 'knowledge:research:company-a',
  bindings: [
    {
      // Stable Portal logical-agent ID, not a browser label or harness name.
      agentId: 'PORTAL_AGENT_ID',
      name: 'research-partner',
      // Knowledge-owned company ID, selected by the deployment administrator.
      companyId: 'knowledge-company-a',
      verifier: createPortalVerifier({
        issuer: 'https://portal.example.com',
        org: 'PORTAL_ORGANIZATION_ID',
        agent: 'research-partner',
      }),
    },
  ],
});

const app = await buildKnowledgeApp({
  researchPrincipalProvider,
  config: {
    // Supply normal Knowledge persistence, engine and notebook-binding settings.
  },
});
```

Each configured verifier must be pinned to the intended issuer, organization,
and logical-agent name. Configure one binding per admitted logical agent. The
map's company ID and the audience are trusted deployment configuration; never
construct them from request headers, query parameters, an unsigned manifest,
or a browser-supplied organization/agent label. The `name` records the intended
binding; the injected verifier's `agent` option enforces the grant target.

Requests supply `Authorization: Bearer <identity-token>`, a matching signed
`x-tealbrick-bundle` for user identities, and
`x-tealbrick-attachment: <signed-attachment>`. The Portal verifier also supports
its separately scoped A2A identity contract. The adapter iterates only trusted
configured verifiers, then checks the signed attachment against the exact
configured agent ID, audience, and required capability. Unsigned principal
objects cannot pass the Portal verifier's attachment check.

Only `research:read` and `research:write` are projected into Knowledge
capabilities, and each is independently verified. The resulting principal ID
combines the verified subject and configured logical-agent ID. The Knowledge
company ID comes exclusively from the trusted binding. Existing notebook
mapping and current-company ownership checks still run after authentication;
a valid Portal attachment does not bypass object authorization or Rules.

## Modes and lifetime

Without the provider, the existing static service-principal and optional
same-origin browser-session behavior remains unchanged. With the provider,
server bearer requests use it exclusively: failed Portal verification never
falls back to a static Knowledge service token. Existing browser-origin checks
and explicitly configured browser-session authentication remain in place.
No Knowledge service credential or Open Notebook credential is substituted
for Portal authorization.

The Portal verifier checks issuer, signature, expiry, identity/grant binding,
attachment audience, active status, organization, agent ID and capability.
Attachment lifetimes must be positive and no greater than 300 seconds; the
current Portal issuer creates five-minute attachments. Verification runs on
each Research authorization pass. This is offline signed-token validation,
not immediate revocation introspection: a previously issued attachment may
remain usable until its expiry. Identity/bundle expiry also bounds admission.
Operators requiring immediate revocation need a separate online enforcement
mechanism; this helper does not promise one.

## Verified boundary and reproduction

The integration test is
`the Portal repository’s `test/portal-core-knowledge.integration.test.mjs``.
It starts disposable Core and actual Knowledge Program HTTP servers with no
Fleet installation or license. It uses the built Portal client/verifier
package, real signed identity bundles and attachments, and remote JWKS
verification. Two independently registered connections named for Eve and
Hermes successfully discover and read mapped Knowledge Research notebooks.

Open Notebook is an explicitly labeled v1.14-shaped HTTP contract stub in this
test. It is not a real Open Notebook deployment, model invocation, browser
acceptance, or running Eve/Hermes harness. The test seeds local notebook state
through the current legacy route before listening; that fixture setup is not
proof of Portal authentication on legacy CRUD.

Negative assertions cover missing/tampered attachments, wrong audience or
capability, unconfigured agents, wrong organizations, foreign notebook access,
unsigned principals, and static bearer fallback. Rejected requests do not
reach the engine stub. Read/write capability projection is also checked.

Reproduce using Node 24 and installed workspace dependencies:

```sh
cd <portal-checkout>
npm run build --workspace @tealbrick/portal
env -i PATH=/opt/homebrew/opt/node@24/bin:/usr/bin:/bin \
  /opt/homebrew/opt/node@24/bin/node --test test/portal-core-knowledge.integration.test.mjs

cd <knowledge-checkout>/program
env -i PATH=/opt/homebrew/opt/node@24/bin:/usr/bin:/bin \
  /opt/homebrew/opt/node@24/bin/node node_modules/vitest/vitest.mjs run \
  src/open-notebook-routes.test.ts src/open-notebook-write-routes.test.ts \
  src/research-browser-session.test.ts src/research-chat-ledger.test.ts
/opt/homebrew/opt/node@24/bin/node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

The integration scenario, 55 existing Research regression tests, and Program
typecheck passed on 2026-09-11. No live deployment or real account/harness UAT
is established by those results.
