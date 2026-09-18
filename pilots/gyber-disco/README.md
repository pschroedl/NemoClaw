# Gyber Disco harness pilots

This pilot adds a credential-isolated inference path and immutable image lanes
for OpenCode, OpenClaw, Hermes, and LangChain Deep Agents Code.

The `workers/llama-api-key` Secret remains the single Kubernetes credential
object used by the `llama-5090` server and `llama-auth-proxy`. Sandbox Pods do
not mount it. The proxy removes any caller-supplied authorization header and
adds the current key only on the hop to `llama-5090`.

The workflow builds OpenCode and the proxy from pinned inputs. It promotes the
three published NemoClaw harness images by immutable digest into Peter's GHCR
namespace. The promoted OpenClaw image is NemoClaw release `v0.0.127`; replacing
its packaged OpenClaw runtime with the separate `pschroedl/openclaw` fork is a
remaining image-lineage task.

The Kubernetes manifest deliberately contains a placeholder image tag. Replace
it with the workflow's registry digest before applying it. Label each approved
OpenShell sandbox namespace with `openshell.ai/inference-client=true`; the
NetworkPolicy admits only Agent Sandbox Pods from those namespaces.
