# Knowledge frontend preview

This static artifact imports the production `web/src/main.tsx`, App and all
its existing components. The separate preview entry installs an app-owned,
in-memory transport before mounting that frontend. Production entrypoints and
API clients are unchanged.

Build from LABS:

```sh
pnpm --dir knowledge/program exec tsc -p web/preview/tsconfig.json --noEmit
pnpm --dir knowledge/program exec vite build --config web/vite.preview.config.ts
```

Publish the contents of `program/preview-dist` as static files. The Portal
integration path is `/miniapp-previews/knowledge/index.html`. No Program server,
provider credentials, database, model or deployment API is involved. The CSP
denies all connections and form submission; every fetch terminates in the
adapter, including unknown operations. External links are intercepted.

Embed with an opaque sandbox (`allow-scripts allow-forms allow-modals`, without
`allow-same-origin`). Serve the preview's static JS/fonts with
`Access-Control-Allow-Origin: *` because module and font requests originate
from that opaque sandbox. Do not apply these headers to application APIs.

## Supported sample interactions

- Library: sample collection/documents; search; create/edit/delete native
  documents and collections; comments, links, access-policy edits.
- Research: expand Local records to explore the sample notebook/source,
  edit notebook metadata, create local source/output records, and ask for a
  clearly marked fixed sample synthesis.
- Brain: sample entity card, facts, timeline, provenance and recall/context.
- Settings and activity use the real frontend with preview runtime metadata.
- Reset reloads the iframe and restores original data. No sample data is stored
  in local storage, sent to the parent or persisted across reloads.

Authenticated Open Notebook sessions, imports, attachments, repository sync,
promotion, external bindings and model generation are not simulated as live
successes. Unsupported requests return `preview_operation_unavailable`.
The existing UI reports Program degraded/engine unavailable because no actual
runtime is connected. This is a preview, not deployment or UAT evidence.

## Verification (2026-09-15)

Preview and source TypeScript checks and static build passed (Node 26.8.1,
supported by the app). Browser smoke verified Library rendering, the real Edit
dialog/save, Reset restoring samples and Brain entity/card/facts rendering.
An adapter check verified local document mutation/reset and zero underlying
fetch calls for an unknown external request. Library list updates after editing;
the existing document detail cache may retain its prior title until refetch.

GitNexus query and upstream impact for App were attempted using the LABS runner;
both returned a storage-version mismatch (index 43/runtime 42). This remains
UNKNOWN, not clean impact evidence. Implementation is additive: no production
function, API client, component or build configuration was modified.
