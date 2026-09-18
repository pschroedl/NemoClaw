# Kubernetes pilot in Peter's NemoClaw fork

This is an independent experimental fork integration, not canonical upstream NemoClaw support. Peter requested and owns this pilot. The accepted scope is a Kubernetes-hosted OpenShell gateway, an in-cluster operator and bounded sandbox lifecycle operations, initially pinned to neon-cadaver. Existing local-container receipts and sandboxes remain unchanged.

`nemoclaw kubernetes ACTION [nc-NAME] --target target.json` routes through Kubernetes exec to a dedicated operator pod. Supported actions are status, list, create, get, start, stop and exec. A create can attach `--provider NAME` only for an already registered provider; it never discovers or reads provider credentials. `exec` requires a command after `--`.

The non-secret target records version 1, kubectl context, kube-system namespace UID, target namespace and UID, gateway StatefulSet and UID, operator pod and UID, operator image digest, client TLS Secret name, gateway name, target node and sandbox image digest. Unknown fields, credential fields, mutable image tags, unrelated sandbox names and invalid identifiers are rejected. Every operation refreshes Kubernetes identities and node/gateway/operator readiness before checking authenticated gateway identity. Replacement identities require explicit rebinding; no inferred local-container authority or synthetic recovery record is used.

The initial create is capped at one CPU and 1 GiB RAM and passes an explicit Kubernetes node selector. It runs the selected image with `sleep infinity` for confinement/lifecycle validation. This is a substrate smoke sandbox, not yet an OpenCode, Hermes or Deep Agents image.

## Required live acceptance

- Gateway user authentication succeeds while unauthenticated calls fail.
- Actual OpenShell sandbox lands on the intended node and its confinement probes pass.
- Exec, stop/start, and persistent fixture recovery succeed through the NemoClaw command.
- Effective policy denies unapproved network access.
- No provider credential or TLS private key leaves Kubernetes.
- The existing OpenCode Deployment remains unchanged until its replacement validates.

Unit tests alone do not establish those live properties. Authentication configuration is still awaiting operator approval; no live sandbox acceptance is claimed.
