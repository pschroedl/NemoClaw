// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";

/** Explicit fork-only pilot authority, separate from local-container receipts. */
export interface KubernetesPilotTarget {
  version: 1;
  context: string;
  clusterUid: string;
  namespace: string;
  namespaceUid: string;
  gatewayStatefulSet: string;
  gatewayUid: string;
  operatorPod: string;
  operatorUid: string;
  operatorImage: string;
  clientTlsSecret: string;
  gatewayName: string;
  node: string;
  image: string;
}

const fields = [
  "version",
  "context",
  "clusterUid",
  "namespace",
  "namespaceUid",
  "gatewayStatefulSet",
  "gatewayUid",
  "operatorPod",
  "operatorUid",
  "operatorImage",
  "clientTlsSecret",
  "gatewayName",
  "node",
  "image",
];
const dnsName = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const uid = /^[a-f0-9-]{36}$/;
const pinnedImage = /^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/;

export function parseKubernetesPilotTarget(value: unknown): KubernetesPilotTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Kubernetes pilot target must be an object");
  }
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !fields.includes(key)) || data.version !== 1) {
    throw new Error(
      "Unsupported Kubernetes pilot target fields or version; credentials are forbidden",
    );
  }
  for (const key of fields.filter((key) => key !== "version")) {
    if (
      typeof data[key] !== "string" ||
      !(data[key] as string).length ||
      (data[key] as string).length > 512
    ) {
      throw new Error(`Invalid Kubernetes pilot target field: ${key}`);
    }
  }
  for (const key of [
    "namespace",
    "gatewayStatefulSet",
    "operatorPod",
    "clientTlsSecret",
    "gatewayName",
    "node",
  ]) {
    if (!dnsName.test(data[key] as string)) throw new Error(`Invalid Kubernetes name: ${key}`);
  }
  for (const key of ["clusterUid", "namespaceUid", "gatewayUid", "operatorUid"]) {
    if (!uid.test(data[key] as string)) throw new Error(`Invalid Kubernetes identity: ${key}`);
  }
  if (
    !/^[a-zA-Z0-9._:/@-]+$/.test(data.context as string) ||
    (data.context as string).startsWith("-")
  ) {
    throw new Error("Invalid Kubernetes context");
  }
  if (!pinnedImage.test(data.image as string) || !pinnedImage.test(data.operatorImage as string)) {
    throw new Error("Pilot and operator images must use immutable sha256 digests");
  }
  return data as unknown as KubernetesPilotTarget;
}

interface KubeObject {
  metadata?: { uid?: string; labels?: Record<string, string> };
  spec?: {
    template?: { spec?: { nodeSelector?: Record<string, string> } };
    nodeName?: string;
    unschedulable?: boolean;
    automountServiceAccountToken?: boolean;
    containers?: Array<{
      name: string;
      image?: string;
      volumeMounts?: Array<{ name: string; mountPath?: string; readOnly?: boolean }>;
    }>;
    volumes?: Array<{ name: string; secret?: { secretName?: string } }>;
  };
  status?: { readyReplicas?: number; conditions?: Array<{ type: string; status: string }> };
}
export interface KubernetesPilotIo {
  read(args: string[]): KubeObject;
  run(args: string[]): void;
}

export function verifyKubernetesPilotTarget(
  target: KubernetesPilotTarget,
  io: KubernetesPilotIo,
): void {
  const base = ["--context", target.context, "--request-timeout=20s"];
  const get = (kind: string, name: string, namespaced = true) =>
    io.read([
      ...base,
      ...(namespaced ? ["-n", target.namespace] : []),
      "get",
      kind,
      name,
      "-o",
      "json",
    ]);
  const cluster = get("namespace", "kube-system", false);
  const namespace = get("namespace", target.namespace, false);
  const gateway = get("statefulset", target.gatewayStatefulSet);
  const operator = get("pod", target.operatorPod);
  const node = get("node", target.node, false);
  if (
    cluster.metadata?.uid !== target.clusterUid ||
    namespace.metadata?.uid !== target.namespaceUid ||
    gateway.metadata?.uid !== target.gatewayUid ||
    operator.metadata?.uid !== target.operatorUid
  ) {
    throw new Error(
      "Kubernetes pilot identity changed; explicitly rebind the target before proceeding",
    );
  }
  if (
    gateway.spec?.template?.spec?.nodeSelector?.["kubernetes.io/hostname"] !== target.node ||
    operator.spec?.nodeName !== target.node ||
    gateway.status?.readyReplicas !== 1 ||
    node.spec?.unschedulable ||
    !node.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True")
  ) {
    throw new Error("Pilot node, gateway readiness, or placement does not match the target");
  }
  const container = operator.spec?.containers?.find((c) => c.name === "operator");
  const tlsVolume = operator.spec?.volumes?.find((v) => v.name === "client-tls");
  const mount = container?.volumeMounts?.find((m) => m.name === "client-tls");
  if (
    operator.metadata?.labels?.app !== "nemoclaw-kubernetes-operator" ||
    container?.image !== target.operatorImage ||
    operator.spec?.automountServiceAccountToken !== false ||
    tlsVolume?.secret?.secretName !== target.clientTlsSecret ||
    mount?.readOnly !== true ||
    mount?.mountPath !== `/home/operator/.config/openshell/gateways/${target.gatewayName}/mtls` ||
    !operator.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True")
  ) {
    throw new Error("Operator image, readiness, or opaque TLS reference does not match the target");
  }
}

export function kubernetesPilotArgs(
  target: KubernetesPilotTarget,
  action: string,
  name?: string,
  command: string[] = [],
  provider?: string,
): string[] {
  if (!["status", "list", "create", "get", "start", "stop", "exec"].includes(action)) {
    throw new Error("Supported pilot actions: status, list, create, get, start, stop, exec");
  }
  if (
    !["status", "list"].includes(action) &&
    (!name || !/^nc-[a-z0-9][a-z0-9-]{0,39}$/.test(name))
  ) {
    throw new Error(
      "Sandbox name must begin nc- and contain only lowercase letters, digits and hyphens",
    );
  }
  if (["status", "list"].includes(action) && name)
    throw new Error("This action does not accept a sandbox name");
  if (command.length && action !== "exec") throw new Error("Only exec accepts a command after --");
  if (action === "exec" && !command.length) throw new Error("exec requires a command after --");
  if (provider && (action !== "create" || !dnsName.test(provider)))
    throw new Error("Provider must be an existing provider name for create");
  const args = action === "status" ? ["status"] : ["sandbox", action];
  if (action === "create") {
    args.push(
      "--name",
      name!,
      "--from",
      target.image,
      "--cpu",
      "1",
      "--memory",
      "1Gi",
      "--driver-config-json",
      JSON.stringify({
        kubernetes: { pod: { node_selector: { "kubernetes.io/hostname": target.node } } },
      }),
      "--label",
      "nemoclaw-pilot=kubernetes",
      "--no-auto-providers",
      "--detach",
    );
    if (provider) args.push("--provider", provider);
    args.push("--", "sleep", "infinity");
  } else if (name) {
    args.push(name);
    if (action === "exec") args.push("--", ...command);
  }
  return [
    "--context",
    target.context,
    "-n",
    target.namespace,
    "exec",
    target.operatorPod,
    "-c",
    "operator",
    "--",
    "openshell",
    "--gateway",
    target.gatewayName,
    ...args,
  ];
}

export function runKubernetesPilot(
  file: string,
  action: string,
  name?: string,
  command: string[] = [],
  provider?: string,
): void {
  const target = parseKubernetesPilotTarget(JSON.parse(fs.readFileSync(file, "utf8")));
  const io: KubernetesPilotIo = {
    read(args) {
      const result = spawnSync("kubectl", args, {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
      });
      if (result.error || result.status !== 0)
        throw new Error("Kubernetes identity check failed; verify context and access");
      return JSON.parse(result.stdout);
    },
    run(args) {
      const result = spawnSync("kubectl", args, { stdio: "inherit", timeout: 300000 });
      if (result.error || result.status !== 0)
        throw new Error(`Kubernetes pilot operation failed (exit ${result.status ?? "unknown"})`);
    },
  };
  const args = kubernetesPilotArgs(target, action, name, command, provider);
  verifyKubernetesPilotTarget(target, io);
  // Health/status may return zero even when authentication fails. Require the
  // gateway's authenticated identity RPC before any lifecycle action.
  io.run([
    "--context",
    target.context,
    "-n",
    target.namespace,
    "exec",
    target.operatorPod,
    "-c",
    "operator",
    "--",
    "openshell",
    "--gateway",
    target.gatewayName,
    "whoami",
  ]);
  io.run(args);
}
