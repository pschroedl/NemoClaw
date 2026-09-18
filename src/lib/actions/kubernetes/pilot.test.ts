// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  kubernetesPilotArgs,
  parseKubernetesPilotTarget,
  verifyKubernetesPilotTarget,
} from "./pilot";

const id = "11111111-1111-1111-1111-111111111111";
const target = {
  version: 1,
  context: "cluster",
  clusterUid: id,
  namespace: "pilot",
  namespaceUid: id,
  gatewayStatefulSet: "gateway",
  gatewayUid: id,
  operatorPod: "operator",
  operatorUid: id,
  operatorImage: `localhost/operator@sha256:${"a".repeat(64)}`,
  clientTlsSecret: "client-tls",
  gatewayName: "neon",
  node: "neon-cadaver",
  image: `example.org/base@sha256:${"b".repeat(64)}`,
};

describe("Kubernetes pilot authority", () => {
  it("rejects credentials and unknown fields before accessing Kubernetes", () => {
    expect(() => parseKubernetesPilotTarget({ ...target, apiKey: "forbidden" })).toThrow(
      "credentials are forbidden",
    );
    expect(() => parseKubernetesPilotTarget({ ...target, version: 2 })).toThrow();
    expect(() => parseKubernetesPilotTarget({ ...target, image: "base:latest" })).toThrow(
      "immutable",
    );
    expect(() => parseKubernetesPilotTarget({ ...target, context: "--server=attacker" })).toThrow();
    expect(() => parseKubernetesPilotTarget({ ...target, namespace: "../other" })).toThrow();
  });

  it("pins placement and image while attaching an existing provider without reading credentials", () => {
    const args = kubernetesPilotArgs(
      parseKubernetesPilotTarget(target),
      "create",
      "nc-test",
      [],
      "llama",
    );
    expect(args.slice(0, 4)).toEqual(["--context", "cluster", "-n", "pilot"]);
    expect(args).toContain(target.image);
    expect(args).toContain("--no-auto-providers");
    expect(args).toContain("llama");
    expect(JSON.parse(args[args.indexOf("--driver-config-json") + 1])).toEqual({
      kubernetes: { pod: { node_selector: { "kubernetes.io/hostname": "neon-cadaver" } } },
    });
    expect(args).not.toContain("--credential");
  });

  it.each(["existing-pilot", "--all", "nc-;rm", "nc-", "nc-../other"])(
    "rejects unrelated sandbox name %s",
    (name) => {
      expect(() => kubernetesPilotArgs(parseKubernetesPilotTarget(target), "stop", name)).toThrow();
    },
  );

  it("rejects unsupported lifecycle operations and argument shapes", () => {
    const t = parseKubernetesPilotTarget(target);
    expect(() => kubernetesPilotArgs(t, "delete", "nc-test")).toThrow();
    expect(() => kubernetesPilotArgs(t, "exec", "nc-test")).toThrow();
    expect(() => kubernetesPilotArgs(t, "start", "nc-test", ["sh"])).toThrow();
    expect(() => kubernetesPilotArgs(t, "list", undefined, [], "llama")).toThrow();
  });

  it("keeps remote command arguments opaque instead of invoking a host shell", () => {
    const command = ["printf", "%s", "$(touch /tmp/unwanted)"];
    const args = kubernetesPilotArgs(
      parseKubernetesPilotTarget(target),
      "exec",
      "nc-test",
      command,
    );
    expect(args.slice(-4)).toEqual(["--", ...command]);
  });

  function resources() {
    return [
      { metadata: { uid: id } },
      { metadata: { uid: id } },
      {
        metadata: { uid: id },
        spec: {
          template: { spec: { nodeSelector: { "kubernetes.io/hostname": "neon-cadaver" } } },
        },
        status: { readyReplicas: 1 },
      },
      {
        metadata: { uid: id, labels: { app: "nemoclaw-kubernetes-operator" } },
        spec: {
          nodeName: "neon-cadaver",
          automountServiceAccountToken: false,
          containers: [
            {
              name: "operator",
              image: target.operatorImage,
              volumeMounts: [
                {
                  name: "client-tls",
                  readOnly: true,
                  mountPath: "/home/operator/.config/openshell/gateways/neon/mtls",
                },
              ],
            },
          ],
          volumes: [{ name: "client-tls", secret: { secretName: "client-tls" } }],
        },
        status: { conditions: [{ type: "Ready", status: "True" }] },
      },
      {
        spec: { unschedulable: false },
        status: { conditions: [{ type: "Ready", status: "True" }] },
      },
    ];
  }

  it("accepts matching live identities without reading a Secret object", () => {
    const queue = resources();
    const calls: string[][] = [];
    verifyKubernetesPilotTarget(parseKubernetesPilotTarget(target), {
      read(args) {
        calls.push(args);
        return queue.shift()!;
      },
      run() {},
    });
    expect(calls).toHaveLength(5);
    expect(calls.flat()).not.toContain("secret");
  });

  it("fails closed on replaced cluster identity before executing an operation", () => {
    const queue = resources();
    queue[0].metadata!.uid = "22222222-2222-2222-2222-222222222222";
    expect(() =>
      verifyKubernetesPilotTarget(parseKubernetesPilotTarget(target), {
        read() {
          return queue.shift()!;
        },
        run() {
          throw new Error("must not execute");
        },
      }),
    ).toThrow("identity changed");
  });

  it("fails closed when the selected node is cordoned", () => {
    const queue = resources();
    queue[4].spec!.unschedulable = true;
    expect(() =>
      verifyKubernetesPilotTarget(parseKubernetesPilotTarget(target), {
        read() {
          return queue.shift()!;
        },
        run() {},
      }),
    ).toThrow("placement");
  });
});
