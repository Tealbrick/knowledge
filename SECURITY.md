# Security

## Reporting

Do not put credentials, customer content or exploit details in public issues.
Use the repository's **Security → Report a vulnerability** option when enabled.
This release candidate has not yet verified a public reporting channel; enabling
and testing that channel is a publication gate. Until then, contact a repository
maintainer privately through an existing trusted channel. No response-time or
supported-version guarantee is established by this candidate.

## System boundary

Knowledge provides documents, partition-scoped memory and mapped research.
The supported container entrypoint exposes an authenticated HTTP edge and keeps
the Program on loopback. The bundled Brain is an internal service. Open Notebook
and its database require separate private networking and credentials.

Deploy a separate instance and durable volumes for each customer workspace.
Within an instance, agent principals and their partition/capability grants are
separate from the whole-instance operator. An instance recovery token is not an
agent credential. Portal owner sessions, Portal attachments and direct runtime
principals have distinct authorization contracts.

## Required properties

- Reject missing, invalid, expired or revoked credentials at the owning boundary.
- Bind every agent operation to server-authorized partitions, resources and
  capabilities; labels and caller-supplied identifiers grant no authority.
- Keep provider keys and recovery credentials in trusted server storage. Never
  expose them in browser state, URLs, tool arguments or routine logs.
- Require owner authority for model endpoints and other privileged settings.
- Treat documents, URLs, uploads, model output and upstream responses as
  untrusted input. Bound parsing and prevent path or command interpretation.
- Preserve idempotency and uncertain-write reconciliation for external writes.
- Protect browser mutations against cross-origin requests and revalidate live
  Portal grants before dispatch after potentially slow uploads.
- Preserve durable data and credential ownership across restart, backup and
  restore. Health alone does not establish model readiness or recovery.
- Distribute public images without injecting publisher registry or GitHub
  credentials into customer environments.

## Review scope and limitations

Authentication bypass, cross-partition access, privilege escalation, sensitive
data exposure and attacker-controlled execution or network access are reportable
when a concrete reachable boundary is established. Deployment prerequisites
and effective mitigations must be stated. No finding classes are excluded or
accepted as risk by this document.

Source, fixture tests, deployed behavior and human acceptance are separate
evidence levels. Public exposure of the raw Program or internal sidecars is not
the documented container deployment. This distinction does not excuse a
reachable vulnerability in those components. Bundled upstream components retain
their applicable security guidance and licences.
