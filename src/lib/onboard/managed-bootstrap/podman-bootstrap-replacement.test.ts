// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFilePodmanBootstrapJournalStore,
  type PodmanBootstrapJournalStore,
} from "./podman-bootstrap-journal";
import {
  PODMAN_BOOTSTRAP_IDENTITY_LABEL,
  PODMAN_BOOTSTRAP_STATE_DIRECTORY,
  PODMAN_BOOTSTRAP_STATE_VOLUME_LABEL,
  type PodmanBootstrapPreparedReplacement,
  prepareStoppedPodmanBootstrapReplacement,
  publishExactPodmanBootstrapReplacement,
  rollbackPodmanBootstrapBeforeCommit,
  stopExactPodmanBootstrapOriginal,
} from "./podman-bootstrap-replacement";
import {
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_WORKSPACE_LABEL,
} from "./podman-held-workload";
import {
  PODMAN_WATCHER_LEASE_SCHEMA_VERSION,
  type PodmanGatewayWatcherLease,
} from "./podman-watcher-lease";

import {
  BOOTSTRAP_IDENTITY,
  ORIGINAL_RUNTIME_ID,
  REPLACEMENT_RUNTIME_ID,
  EXTRA_RUNTIME_ID,
  REPLACEMENT_IMAGE_ID,
  ENGINE_AUTHORITY_ID,
  SANDBOX_NAME,
  SANDBOX_ID,
  ORIGINAL_NAME,
  STAGING_NAME,
  STATE_VOLUME_NAME,
  STATE_VOLUME_MOUNTPOINT,
  ENVIRONMENT,
  LABELS,
  REPLACEMENT_LABELS,
  STATE_VOLUME_LABELS,
  heldWorkload,
  plan,
  PodmanHarness,
} from "./podman-bootstrap-replacement.test-support";

const roots: string[] = [];

function journalStore(): PodmanBootstrapJournalStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-replacement-test-"));
  roots.push(root);
  return createFilePodmanBootstrapJournalStore(root);
}

function watcherLease() {
  const assertStillStopped = vi.fn();
  const resumeAndProve = vi.fn();
  const resumeForObservationAndProve = vi.fn();
  const requiesceAndProve = vi.fn();
  const lease: PodmanGatewayWatcherLease = {
    record: {
      schemaVersion: PODMAN_WATCHER_LEASE_SCHEMA_VERSION,
      holder: { pid: 9_100, processStartIdentity: "holder-start-100" },
      leaseId: "123e4567-e89b-42d3-a456-426614174000",
      phase: "stopped",
      gatewayName: "default",
      gatewayPort: 8080,
      launchIdentity: "launch-default",
      ownerIdentity: "owner-default",
      ownerKind: "managed-service",
      pid: 1234,
      processStartIdentity: "pid-start-1234",
    },
    assertStillHeld: assertStillStopped,
    assertStillStopped,
    resumeForObservationAndProve,
    requiesceAndProve,
    resumeAndProve,
  };
  return { assertStillStopped, lease, resumeAndProve };
}

function prepare(
  harness: PodmanHarness,
  store: PodmanBootstrapJournalStore,
  lease: PodmanGatewayWatcherLease,
): PodmanBootstrapPreparedReplacement {
  return prepareStoppedPodmanBootstrapReplacement({
    engine: harness.engine,
    journalStore: store,
    watcherLease: lease,
    plan,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("Podman bootstrap stopped replacement", () => {
  it("journals authority before creating one exact stopped final-labelled replacement", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();

    const prepared = prepare(harness, store, watcher.lease);

    expect(prepared.replacementRuntimeId).toBe(REPLACEMENT_RUNTIME_ID);
    expect(prepared.replacementStagingName).toBe(STAGING_NAME);
    expect(prepared.replacementStateVolumeName).toBe(STATE_VOLUME_NAME);
    expect(prepared.replacementStateVolumeMountpoint).toBe(STATE_VOLUME_MOUNTPOINT);
    expect(prepared.journal.phase).toBe("replacement-created");
    expect(prepared.journal.engineAuthorityId).toBe(ENGINE_AUTHORITY_ID);
    expect(prepared.journal.watcherLeaseId).toBe(watcher.lease.record.leaseId);
    expect(harness.replacement).toMatchObject({
      id: REPLACEMENT_RUNTIME_ID,
      name: STAGING_NAME,
      image: REPLACEMENT_IMAGE_ID,
      labels: REPLACEMENT_LABELS,
      running: false,
    });
    expect(harness.stateVolume).toEqual({
      name: STATE_VOLUME_NAME,
      mountpoint: STATE_VOLUME_MOUNTPOINT,
      labels: STATE_VOLUME_LABELS,
    });
    expect(harness.calls).toContainEqual([
      "volume",
      "create",
      "--driver",
      "local",
      "--label",
      `${PODMAN_BOOTSTRAP_IDENTITY_LABEL}=${BOOTSTRAP_IDENTITY}`,
      "--label",
      `${PODMAN_BOOTSTRAP_STATE_VOLUME_LABEL}=true`,
      "--label",
      `${PODMAN_SANDBOX_ID_LABEL}=${SANDBOX_ID}`,
      "--label",
      `${PODMAN_SANDBOX_NAME_LABEL}=${SANDBOX_NAME}`,
      STATE_VOLUME_NAME,
    ]);
    expect(harness.calls).toContainEqual(
      expect.arrayContaining([
        "--volume",
        `${STATE_VOLUME_NAME}:${PODMAN_BOOTSTRAP_STATE_DIRECTORY}:rw,z,copy`,
      ]),
    );
    expect(harness.capturedEnvironmentMode).toBe(0o600);
    expect(harness.capturedEnvironmentContents).toBe(`${ENVIRONMENT.join("\n")}\n`);
    expect(fs.existsSync(harness.capturedEnvironmentFile as string)).toBe(false);
    expect(harness.calls.flat().join("\u0000")).not.toContain(ENVIRONMENT[1]);
    expect(JSON.stringify(prepared.journal)).not.toContain("do-not-put-this-in-process-argv");
    expect(watcher.assertStillStopped.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(watcher.resumeAndProve).not.toHaveBeenCalled();
  });

  it("rejects a held workload outside NemoClaw's default OpenShell workspace", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();

    expect(() =>
      prepareStoppedPodmanBootstrapReplacement({
        engine: harness.engine,
        journalStore: store,
        watcherLease: watcher.lease,
        plan: {
          ...plan,
          heldWorkload: {
            ...heldWorkload,
            labels: { ...LABELS, [PODMAN_SANDBOX_WORKSPACE_LABEL]: "another-workspace" },
          },
        },
      }),
    ).toThrow("exact OpenShell ownership");
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
    expect(harness.calls).toEqual([]);
  });

  it("rejects a held workload whose name does not encode its exact OpenShell identity", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();

    expect(() =>
      prepareStoppedPodmanBootstrapReplacement({
        engine: harness.engine,
        journalStore: store,
        watcherLease: watcher.lease,
        plan: {
          ...plan,
          heldWorkload: { ...heldWorkload, containerName: `openshell-sandbox-${SANDBOX_NAME}` },
        },
      }),
    ).toThrow("container name does not match exact OpenShell ownership");
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
    expect(harness.calls).toEqual([]);
  });

  it("accepts a stable Podman inspect with reordered environment entries", () => {
    const harness = new PodmanHarness();
    harness.replacementEnvironment = [...ENVIRONMENT].reverse();
    const store = journalStore();
    const watcher = watcherLease();

    const prepared = prepare(harness, store, watcher.lease);

    expect(prepared.journal.phase).toBe("replacement-created");
    expect(harness.replacement?.environment).toEqual([...ENVIRONMENT].reverse());
  });

  it("accepts an empty non-authoritative Podman volume mount mode", () => {
    const harness = new PodmanHarness();
    harness.stateVolumeMountMode = "";
    const store = journalStore();
    const watcher = watcherLease();

    const prepared = prepare(harness, store, watcher.lease);

    expect(prepared.journal.phase).toBe("replacement-created");
    expect(harness.replacement?.mounts[0]?.Mode).toBe("");
  });

  it("keeps pre-create authority when Podman create fails without exposing command output", () => {
    const harness = new PodmanHarness();
    harness.createResult = {
      status: 125,
      stdout: "credential-in-stdout",
      stderr: "credential-in-stderr",
      error: new Error("socket interrupted"),
    };
    const store = journalStore();
    const watcher = watcherLease();

    expect(() => prepare(harness, store, watcher.lease)).toThrowError(
      /^(?![\s\S]*(?:credential-in-stdout|credential-in-stderr))[\s\S]*failed with status 125: socket interrupted/u,
    );
    expect(store.load(BOOTSTRAP_IDENTITY)?.phase).toBe("state-volume-created");
  });

  it("rejects identity flags supplied through provider runtime arguments", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();

    expect(() =>
      prepareStoppedPodmanBootstrapReplacement({
        engine: harness.engine,
        journalStore: store,
        watcherLease: watcher.lease,
        plan: { ...plan, runtimeArgs: ["--name=attacker-selected"] },
      }),
    ).toThrow("cannot set '--name'");
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
    expect(harness.calls).toEqual([]);
  });

  it.each(["-eSECRET=1", "-lcom.nvidia.nemoclaw.override=true", "-d=true"])(
    "rejects attached protected shorthand %s before invoking Podman",
    (argument) => {
      const harness = new PodmanHarness();
      const store = journalStore();
      const watcher = watcherLease();

      expect(() =>
        prepareStoppedPodmanBootstrapReplacement({
          engine: harness.engine,
          journalStore: store,
          watcherLease: watcher.lease,
          plan: { ...plan, runtimeArgs: [argument] },
        }),
      ).toThrow("cannot set");
      expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
      expect(harness.calls).toEqual([]);
    },
  );

  it("does not confuse supported long options with protected shorthand", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();
    const runtimeArgs = [
      ...plan.runtimeArgs,
      "--device",
      "nvidia.com/gpu=all",
      "--log-driver",
      "journald",
      "--expose",
      "8080",
    ];

    const prepared = prepareStoppedPodmanBootstrapReplacement({
      engine: harness.engine,
      journalStore: store,
      watcherLease: watcher.lease,
      plan: { ...plan, runtimeArgs },
    });

    expect(prepared.journal.phase).toBe("replacement-created");
    expect(harness.calls).toContainEqual(
      expect.arrayContaining(["container", "create", ...runtimeArgs]),
    );
  });

  it("rejects runtime mounts that could shadow image transaction state", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();

    expect(() =>
      prepareStoppedPodmanBootstrapReplacement({
        engine: harness.engine,
        journalStore: store,
        watcherLease: watcher.lease,
        plan: {
          ...plan,
          runtimeArgs: [
            "--mount",
            "type=volume,source=attacker,destination=/var/lib/nemoclaw/managed-startup",
          ],
        },
      }),
    ).toThrow("cannot shadow /var/lib/nemoclaw");
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
    expect(harness.calls).toEqual([]);
  });

  it("recognizes the Podman dest alias without truncating its value", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();

    const prepared = prepareStoppedPodmanBootstrapReplacement({
      engine: harness.engine,
      journalStore: store,
      watcherLease: watcher.lease,
      plan: {
        ...plan,
        runtimeArgs: [
          "--mount",
          `type=volume,source=workspace,dest=${PODMAN_BOOTSTRAP_STATE_DIRECTORY}=cache`,
        ],
      },
    });

    expect(prepared.journal.phase).toBe("replacement-created");
  });

  it("rejects a Podman mount specification without a destination", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();

    expect(() =>
      prepareStoppedPodmanBootstrapReplacement({
        engine: harness.engine,
        journalStore: store,
        watcherLease: watcher.lease,
        plan: { ...plan, runtimeArgs: ["--mount", "type=volume,source=workspace"] },
      }),
    ).toThrow("requires one destination");
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
    expect(harness.calls).toEqual([]);
  });

  it("checks every recognized Podman mount destination before rejecting ambiguity", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();

    expect(() =>
      prepareStoppedPodmanBootstrapReplacement({
        engine: harness.engine,
        journalStore: store,
        watcherLease: watcher.lease,
        plan: {
          ...plan,
          runtimeArgs: [
            "--mount",
            "type=volume,source=workspace,destination=/sandbox,dest=/var/lib/nemoclaw",
          ],
        },
      }),
    ).toThrow("cannot shadow /var/lib/nemoclaw");
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
    expect(harness.calls).toEqual([]);
  });

  it("fails before journaling when the deterministic state-volume name is occupied", () => {
    const harness = new PodmanHarness();
    harness.stateVolume = {
      name: STATE_VOLUME_NAME,
      mountpoint: STATE_VOLUME_MOUNTPOINT,
      labels: STATE_VOLUME_LABELS,
    };
    const store = journalStore();
    const watcher = watcherLease();

    expect(() => prepare(harness, store, watcher.lease)).toThrow(
      "state-volume name is already in use",
    );
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
    expect(harness.replacement).toBeNull();
  });

  it("rejects a replacement that starts before the image-owned transaction owns it", () => {
    const harness = new PodmanHarness();
    harness.replacementStartsOnCreate = true;
    const store = journalStore();
    const watcher = watcherLease();

    expect(() => prepare(harness, store, watcher.lease)).toThrow(
      "identity or state changed after it was pinned",
    );
    expect(store.load(BOOTSTRAP_IDENTITY)?.phase).toBe("state-volume-created");
  });

  it("accepts additional labels inherited from the pinned replacement image", () => {
    const harness = new PodmanHarness();
    harness.replacementImageLabels = {
      "io.nvidia.nemoclaw.managed-image.contract": "1",
      "org.opencontainers.image.revision": "candidate-revision",
    };
    const store = journalStore();
    const watcher = watcherLease();

    expect(() => prepare(harness, store, watcher.lease)).not.toThrow();
  });

  it("stops only the exact original after the stopped replacement remains stable", () => {
    const harness = new PodmanHarness();
    const capture = vi.spyOn(harness.engine, "capture");
    const store = journalStore();
    const watcher = watcherLease();
    const prepared = prepare(harness, store, watcher.lease);

    const stopped = stopExactPodmanBootstrapOriginal({
      engine: harness.engine,
      journalStore: store,
      watcherLease: watcher.lease,
      prepared,
      heldWorkload,
    });

    expect(stopped.journal.phase).toBe("original-stopped");
    expect(harness.original.running).toBe(false);
    expect(harness.originalExists).toBe(false);
    expect(harness.replacement?.running).toBe(false);
    expect(harness.calls).toContainEqual(["container", "stop", ORIGINAL_RUNTIME_ID]);
    expect(harness.calls).toContainEqual(["container", "wait", ORIGINAL_RUNTIME_ID]);
    expect(capture).toHaveBeenCalledWith(["container", "stop", ORIGINAL_RUNTIME_ID], 60_000);
    expect(capture).toHaveBeenCalledWith(["container", "wait", ORIGINAL_RUNTIME_ID], 60_000);
    expect(watcher.resumeAndProve).not.toHaveBeenCalled();
  });

  it("accepts a lost stop acknowledgement when exact wait proves exit", () => {
    const harness = new PodmanHarness();
    harness.stopStatus = 125;
    const store = journalStore();
    const watcher = watcherLease();
    const prepared = prepare(harness, store, watcher.lease);

    const stopped = stopExactPodmanBootstrapOriginal({
      engine: harness.engine,
      journalStore: store,
      watcherLease: watcher.lease,
      prepared,
      heldWorkload,
    });

    expect(stopped.journal.phase).toBe("original-stopped");
    expect(harness.original.running).toBe(false);
    expect(harness.originalExists).toBe(false);
    expect(harness.calls).toContainEqual(["container", "stop", ORIGINAL_RUNTIME_ID]);
    expect(harness.calls).toContainEqual(["container", "wait", ORIGINAL_RUNTIME_ID]);
  });

  it("accepts watcher quiescence that already stopped the exact original", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();
    const prepared = prepare(harness, store, watcher.lease);
    harness.original.running = false;

    const stopped = stopExactPodmanBootstrapOriginal({
      engine: harness.engine,
      journalStore: store,
      watcherLease: watcher.lease,
      prepared,
      heldWorkload,
    });

    expect(stopped.journal.phase).toBe("original-stopped");
    expect(harness.originalExists).toBe(false);
    expect(harness.calls).not.toContainEqual(["container", "stop", ORIGINAL_RUNTIME_ID]);
    expect(harness.calls).toContainEqual(["container", "rm", ORIGINAL_RUNTIME_ID]);
  });

  it.each([
    [
      "state-volume mountpoint",
      (prepared: PodmanBootstrapPreparedReplacement) => ({
        ...prepared,
        replacementStateVolumeMountpoint: "/different/state-volume/mountpoint",
      }),
    ],
    [
      "replacement fingerprint",
      (prepared: PodmanBootstrapPreparedReplacement) => ({
        ...prepared,
        replacementSpecFingerprint: "f".repeat(64),
      }),
    ],
  ])("rejects a prepared replacement with a changed %s", (_label, mutate) => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();
    const prepared = prepare(harness, store, watcher.lease);

    expect(() =>
      stopExactPodmanBootstrapOriginal({
        engine: harness.engine,
        journalStore: store,
        watcherLease: watcher.lease,
        prepared: mutate(prepared),
        heldWorkload,
      }),
    ).toThrow("does not match the durable journal");
    expect(harness.original.running).toBe(true);
    expect(store.load(BOOTSTRAP_IDENTITY)?.phase).toBe("replacement-created");
  });

  it("publishes the exact running replacement under OpenShell's authoritative name", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();
    const prepared = prepare(harness, store, watcher.lease);
    stopExactPodmanBootstrapOriginal({
      engine: harness.engine,
      journalStore: store,
      watcherLease: watcher.lease,
      prepared,
      heldWorkload,
    });
    expect(harness.replacement).not.toBeNull();
    harness.replacement!.running = true;

    publishExactPodmanBootstrapReplacement({
      engine: harness.engine,
      journalStore: store,
      watcherLease: watcher.lease,
      prepared,
      heldWorkload,
    });
    publishExactPodmanBootstrapReplacement({
      engine: harness.engine,
      journalStore: store,
      watcherLease: watcher.lease,
      prepared,
      heldWorkload,
    });

    expect(harness.replacement?.name).toBe(ORIGINAL_NAME);
    expect(harness.calls).toContainEqual([
      "container",
      "rename",
      REPLACEMENT_RUNTIME_ID,
      ORIGINAL_NAME,
    ]);
    expect(
      harness.calls.filter((args) => args[0] === "container" && args[1] === "rename"),
    ).toHaveLength(1);
    expect(store.load(BOOTSTRAP_IDENTITY)?.phase).toBe("original-stopped");
  });

  it("rolls back the replacement after the original handoff", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();
    const prepared = prepare(harness, store, watcher.lease);
    stopExactPodmanBootstrapOriginal({
      engine: harness.engine,
      journalStore: store,
      watcherLease: watcher.lease,
      prepared,
      heldWorkload,
    });

    const receipt = rollbackPodmanBootstrapBeforeCommit({
      engine: harness.engine,
      journalStore: store,
      watcherLease: watcher.lease,
      bootstrapIdentity: BOOTSTRAP_IDENTITY,
      heldWorkload,
    });

    expect(receipt).toEqual({
      bootstrapIdentity: BOOTSTRAP_IDENTITY,
      originalRuntimeId: ORIGINAL_RUNTIME_ID,
      originalStarted: false,
      replacementRemoved: true,
      replacementStateVolumeRemoved: true,
    });
    expect(harness.originalExists).toBe(false);
    expect(harness.replacement).toBeNull();
    expect(harness.stateVolume).toBeNull();
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
    expect(harness.calls).toContainEqual(["container", "rm", REPLACEMENT_RUNTIME_ID]);
    expect(harness.calls).toContainEqual(["volume", "rm", STATE_VOLUME_NAME]);
    expect(harness.calls).not.toContainEqual(["container", "start", ORIGINAL_RUNTIME_ID]);
    expect(watcher.resumeAndProve).not.toHaveBeenCalled();
  });

  it("rolls back a published running replacement after lost Podman acknowledgements", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();
    const prepared = prepare(harness, store, watcher.lease);
    stopExactPodmanBootstrapOriginal({
      engine: harness.engine,
      journalStore: store,
      watcherLease: watcher.lease,
      prepared,
      heldWorkload,
    });
    expect(harness.replacement).not.toBeNull();
    harness.replacement!.name = ORIGINAL_NAME;
    harness.replacement!.running = true;
    harness.replacementStopStatus = 125;
    harness.replacementRemoveStatus = 125;

    const receipt = rollbackPodmanBootstrapBeforeCommit({
      engine: harness.engine,
      journalStore: store,
      watcherLease: watcher.lease,
      bootstrapIdentity: BOOTSTRAP_IDENTITY,
      heldWorkload,
    });

    expect(receipt.replacementRemoved).toBe(true);
    expect(receipt.replacementStateVolumeRemoved).toBe(true);
    expect(harness.replacement).toBeNull();
    expect(harness.stateVolume).toBeNull();
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
    expect(harness.calls).toContainEqual(["container", "stop", REPLACEMENT_RUNTIME_ID]);
    expect(harness.calls).toContainEqual(["container", "wait", REPLACEMENT_RUNTIME_ID]);
    expect(harness.calls).toContainEqual(["container", "rm", REPLACEMENT_RUNTIME_ID]);
  });

  it("reconciles and removes a replacement after its create acknowledgement is lost", () => {
    const harness = new PodmanHarness();
    harness.failReplacementInspectOnce = true;
    const store = journalStore();
    const watcher = watcherLease();
    expect(() => prepare(harness, store, watcher.lease)).toThrow("inspect interrupted");
    expect(store.load(BOOTSTRAP_IDENTITY)).toMatchObject({
      phase: "state-volume-created",
      replacementRuntimeId: null,
    });
    expect(harness.replacement?.id).toBe(REPLACEMENT_RUNTIME_ID);

    const receipt = rollbackPodmanBootstrapBeforeCommit({
      engine: harness.engine,
      journalStore: store,
      watcherLease: watcher.lease,
      bootstrapIdentity: BOOTSTRAP_IDENTITY,
      heldWorkload,
    });

    expect(receipt.originalStarted).toBe(false);
    expect(receipt.replacementRemoved).toBe(true);
    expect(receipt.replacementStateVolumeRemoved).toBe(true);
    expect(harness.original.running).toBe(true);
    expect(harness.replacement).toBeNull();
    expect(harness.stateVolume).toBeNull();
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
  });

  it("fails closed when a recorded state volume disappears before rollback", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();
    prepare(harness, store, watcher.lease);
    harness.stateVolume = null;

    expect(() =>
      rollbackPodmanBootstrapBeforeCommit({
        engine: harness.engine,
        journalStore: store,
        watcherLease: watcher.lease,
        bootstrapIdentity: BOOTSTRAP_IDENTITY,
        heldWorkload,
      }),
    ).toThrow("recorded state volume disappeared before rollback");
    expect(store.load(BOOTSTRAP_IDENTITY)?.phase).toBe("rollback-authorized");
    expect(harness.original.running).toBe(true);
  });

  it("fails closed when rollback discovery finds two staging identities", () => {
    const harness = new PodmanHarness();
    harness.failReplacementInspectOnce = true;
    const store = journalStore();
    const watcher = watcherLease();
    expect(() => prepare(harness, store, watcher.lease)).toThrow("inspect interrupted");
    harness.extraStagingIds = [EXTRA_RUNTIME_ID];

    expect(() =>
      rollbackPodmanBootstrapBeforeCommit({
        engine: harness.engine,
        journalStore: store,
        watcherLease: watcher.lease,
        bootstrapIdentity: BOOTSTRAP_IDENTITY,
        heldWorkload,
      }),
    ).toThrow("ambiguous replacement identities");
    expect(store.load(BOOTSTRAP_IDENTITY)?.phase).toBe("rollback-authorized");
    expect(harness.replacement?.id).toBe(REPLACEMENT_RUNTIME_ID);
  });

  it("rejects a different engine authority before a stopped original can be changed", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();
    const prepared = prepare(harness, store, watcher.lease);
    const otherEngine = new PodmanHarness(`podman-sha256:${"8".repeat(64)}`).engine;

    expect(() =>
      stopExactPodmanBootstrapOriginal({
        engine: otherEngine,
        journalStore: store,
        watcherLease: watcher.lease,
        prepared,
        heldWorkload,
      }),
    ).toThrow("does not match the active engine");
    expect(harness.original.running).toBe(true);
    expect(store.load(BOOTSTRAP_IDENTITY)?.phase).toBe("replacement-created");
  });
});
