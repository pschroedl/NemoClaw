// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import type { ContainerEngineCommandResult } from "../../adapters/container-engine";

import { expect, vi } from "vitest";

import {
  type AuthorityBoundPodmanBootstrapEngine,
  PODMAN_BOOTSTRAP_IDENTITY_LABEL,
  PODMAN_BOOTSTRAP_REPLACEMENT_SCHEMA_VERSION,
  PODMAN_BOOTSTRAP_STATE_DIRECTORY,
  PODMAN_BOOTSTRAP_STATE_VOLUME_LABEL,
  type PodmanBootstrapReplacementPlan,
} from "./podman-bootstrap-replacement";
import {
  PODMAN_MANAGED_LABEL,
  PODMAN_OPENSHELL_MANAGED_BY_LABEL,
  PODMAN_OPENSHELL_MANAGED_BY_VALUE,
  PODMAN_SANDBOX_CONTAINER_PREFIX,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
  PODMAN_SANDBOX_WORKSPACE,
  PODMAN_SANDBOX_WORKSPACE_LABEL,
  type PodmanHeldWorkloadObservation,
} from "./podman-held-workload";

export const BOOTSTRAP_IDENTITY = "1".repeat(64);
export const ORIGINAL_RUNTIME_ID = "2".repeat(64);
export const REPLACEMENT_RUNTIME_ID = "3".repeat(64);
export const EXTRA_RUNTIME_ID = "4".repeat(64);
const ORIGINAL_IMAGE_ID = `sha256:${"5".repeat(64)}`;
export const REPLACEMENT_IMAGE_ID = `sha256:${"6".repeat(64)}`;
export const ENGINE_AUTHORITY_ID = `podman-sha256:${"7".repeat(64)}`;
export const SANDBOX_NAME = "alpha";
export const SANDBOX_ID = "sandbox-alpha";
export const ORIGINAL_NAME = `${PODMAN_SANDBOX_CONTAINER_PREFIX}${SANDBOX_NAME}-${SANDBOX_ID}`;
export const STAGING_NAME = `${ORIGINAL_NAME}-nemoclaw-bootstrap-111111111111`;
export const STATE_VOLUME_NAME = `${ORIGINAL_NAME}-nemoclaw-state-111111111111`;
export const STATE_VOLUME_MOUNTPOINT = `/var/lib/containers/storage/volumes/${STATE_VOLUME_NAME}/_data`;
const SUPERVISOR_ARGV = ["/opt/openshell/bin/supervisor", "--config", "/etc/openshell.toml"];
const ENTRYPOINT_ARGV = ["/usr/local/bin/nemoclaw-managed-bootstrap"];
const COMMAND_ARGV = ["--apply-root", "--agent", "example-agent"];
export const ENVIRONMENT = [
  "OPENSHELL_SANDBOX_COMMAND=/usr/local/bin/nemoclaw-start",
  "LOW_ENTROPY_PASSWORD=do-not-put-this-in-process-argv",
];
export const LABELS = Object.freeze({
  [PODMAN_MANAGED_LABEL]: "true",
  [PODMAN_SANDBOX_ID_LABEL]: SANDBOX_ID,
  [PODMAN_SANDBOX_NAME_LABEL]: SANDBOX_NAME,
  [PODMAN_SANDBOX_NAMESPACE_LABEL]: "",
  [PODMAN_SANDBOX_WORKSPACE_LABEL]: PODMAN_SANDBOX_WORKSPACE,
});
export const REPLACEMENT_LABELS = Object.freeze({
  ...LABELS,
  [PODMAN_OPENSHELL_MANAGED_BY_LABEL]: PODMAN_OPENSHELL_MANAGED_BY_VALUE,
});
export const STATE_VOLUME_LABELS = Object.freeze({
  [PODMAN_BOOTSTRAP_IDENTITY_LABEL]: BOOTSTRAP_IDENTITY,
  [PODMAN_BOOTSTRAP_STATE_VOLUME_LABEL]: "true",
  [PODMAN_SANDBOX_ID_LABEL]: SANDBOX_ID,
  [PODMAN_SANDBOX_NAME_LABEL]: SANDBOX_NAME,
});

export const heldWorkload = Object.freeze({
  containerName: ORIGINAL_NAME,
  heldWorkloadArgv: [
    "/usr/local/bin/nemoclaw-managed-hold",
    "--bootstrap-identity",
    BOOTSTRAP_IDENTITY,
  ],
  imageContentId: ORIGINAL_IMAGE_ID,
  labels: LABELS,
  runtimeId: ORIGINAL_RUNTIME_ID,
  running: true,
  sandboxId: SANDBOX_ID,
  sandboxName: SANDBOX_NAME,
  supervisorArgv: SUPERVISOR_ARGV,
} satisfies PodmanHeldWorkloadObservation);

export const plan = Object.freeze({
  schemaVersion: PODMAN_BOOTSTRAP_REPLACEMENT_SCHEMA_VERSION,
  bootstrapIdentity: BOOTSTRAP_IDENTITY,
  heldWorkload,
  runtimeArgs: ["--network", "network-id", "--mount", "type=volume,source=workspace,dst=/sandbox"],
  environment: ENVIRONMENT,
  entrypointArgv: ENTRYPOINT_ARGV,
  commandArgv: COMMAND_ARGV,
  replacementImageContentId: REPLACEMENT_IMAGE_ID,
} satisfies PodmanBootstrapReplacementPlan);

interface ContainerState {
  readonly id: string;
  name: string;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly entrypoint: readonly string[];
  readonly command: readonly string[];
  readonly environment: readonly string[];
  readonly mounts: readonly Record<string, unknown>[];
  running: boolean;
}

interface StateVolume {
  readonly name: string;
  readonly mountpoint: string;
  readonly labels: Readonly<Record<string, string>>;
}

export class PodmanHarness {
  public readonly calls: string[][] = [];
  public readonly engine: AuthorityBoundPodmanBootstrapEngine;
  public original: ContainerState = {
    id: ORIGINAL_RUNTIME_ID,
    name: ORIGINAL_NAME,
    image: ORIGINAL_IMAGE_ID,
    labels: LABELS,
    entrypoint: [SUPERVISOR_ARGV[0] as string],
    command: SUPERVISOR_ARGV.slice(1),
    environment: [],
    mounts: [],
    running: true,
  };
  public originalExists = true;
  public replacement: ContainerState | null = null;
  public stateVolume: StateVolume | null = null;
  public extraStagingIds: string[] = [];
  public createResult: ContainerEngineCommandResult | null = null;
  public stopStatus = 0;
  public replacementStopStatus = 0;
  public replacementRemoveStatus = 0;
  public replacementStartsOnCreate = false;
  public failReplacementInspectOnce = false;
  public replacementEnvironment: readonly string[] = ENVIRONMENT;
  public replacementImageLabels: Readonly<Record<string, string>> = {};
  public stateVolumeMountMode = "z";
  public capturedEnvironmentFile: string | null = null;
  public capturedEnvironmentContents: string | null = null;
  public capturedEnvironmentMode: number | null = null;

  public constructor(authorityId = ENGINE_AUTHORITY_ID) {
    this.engine = {
      operation: "managed-bootstrap",
      engineId: "podman",
      displayName: "Podman",
      authorityId,
      capture: (args) => this.capture(args),
      captureHost: vi.fn(),
    };
  }

  private result(
    stdout = "",
    overrides: Partial<ContainerEngineCommandResult> = {},
  ): ContainerEngineCommandResult {
    return { status: 0, stdout, stderr: "", ...overrides };
  }

  private inspectOutput(container: ContainerState): string {
    return JSON.stringify([
      {
        Id: container.id,
        Image: container.image,
        Name: container.name,
        Config: {
          Cmd: container.command,
          Entrypoint: container.entrypoint,
          Env: container.environment,
          Labels: container.labels,
        },
        State: {
          Dead: false,
          Paused: false,
          Restarting: false,
          Running: container.running,
        },
        Mounts: container.mounts,
      },
    ]);
  }

  private volumeInspectOutput(volume: StateVolume): string {
    return JSON.stringify([
      {
        Anonymous: false,
        Driver: "local",
        Labels: volume.labels,
        Mountpoint: volume.mountpoint,
        Name: volume.name,
        Options: {},
        Scope: "local",
      },
    ]);
  }

  private capture(args: readonly string[]): ContainerEngineCommandResult {
    this.calls.push([...args]);
    switch (`${String(args[0])}:${String(args[1])}`) {
      case "volume:exists":
        return this.result("", { status: args[2] === this.stateVolume?.name ? 0 : 1 });
      case "volume:create":
        return this.createStateVolume();
      case "volume:inspect":
        return args[2] === this.stateVolume?.name
          ? this.result(this.volumeInspectOutput(this.stateVolume))
          : this.result("", { status: 125 });
      case "volume:rm":
        return this.removeStateVolume(args);
      case "container:create":
        return this.createContainer(args);
      case "container:inspect":
        return this.inspectContainer(args);
      case "container:stop":
        if (args[2] === this.original.id) {
          this.original.running = false;
          return this.result(this.original.id, { status: this.stopStatus });
        }
        if (args[2] === this.replacement?.id) {
          this.replacement.running = false;
          return this.result(this.replacement.id, { status: this.replacementStopStatus });
        }
        return this.result("", { status: 125 });
      case "container:wait": {
        const container =
          args[2] === this.original.id && this.originalExists
            ? this.original
            : args[2] === this.replacement?.id
              ? this.replacement
              : null;
        return container && !container.running
          ? this.result("0\n")
          : this.result("", { status: 125 });
      }
      case "container:start":
        expect(args[2]).toBe(this.original.id);
        expect(this.originalExists).toBe(true);
        this.original.running = true;
        return this.result(this.original.id);
      case "container:rm": {
        switch (args[2]) {
          case this.original.id:
            expect(this.originalExists).toBe(true);
            this.originalExists = false;
            return this.result();
          case this.replacement?.id:
            if (this.replacement?.running) return this.result("", { status: 125 });
            this.replacement = null;
            return this.result("", { status: this.replacementRemoveStatus });
          default:
            return this.result("", { status: 125 });
        }
      }
      case "container:exists": {
        const exists =
          (args[2] === this.original.id && this.originalExists) || args[2] === this.replacement?.id;
        return this.result("", { status: exists ? 0 : 1 });
      }
      case "container:ls": {
        const filter = args[args.indexOf("--filter") + 1] ?? "";
        const exactName = /^name=\^(.+)\$$/u.exec(filter)?.[1] ?? "";
        const ids = [
          ...(this.replacement?.name === exactName ? [this.replacement.id] : []),
          ...this.extraStagingIds,
        ];
        return this.result(JSON.stringify(ids.map((Id) => ({ Id }))));
      }
      case "container:rename":
        if (args[2] !== this.replacement?.id || args[3] !== ORIGINAL_NAME) {
          return this.result("", { status: 125 });
        }
        this.replacement.name = ORIGINAL_NAME;
        return this.result();
      default:
        throw new Error(`Unexpected Podman command: ${args.join(" ")}`);
    }
  }

  private createStateVolume(): ContainerEngineCommandResult {
    switch (this.stateVolume) {
      case null:
        this.stateVolume = {
          name: STATE_VOLUME_NAME,
          mountpoint: STATE_VOLUME_MOUNTPOINT,
          labels: STATE_VOLUME_LABELS,
        };
        return this.result(`${STATE_VOLUME_NAME}\n`);
      default:
        return this.result("", { status: 125 });
    }
  }

  private removeStateVolume(args: readonly string[]): ContainerEngineCommandResult {
    const removable = args[2] === this.stateVolume?.name && this.replacement === null;
    switch (removable) {
      case true:
        this.stateVolume = null;
        return this.result();
      default:
        return this.result("", { status: 125 });
    }
  }

  private createContainer(args: readonly string[]): ContainerEngineCommandResult {
    const environmentFileIndex = args.indexOf("--env-file") + 1;
    const environmentFile = args[environmentFileIndex] as string;
    this.capturedEnvironmentFile = environmentFile;
    this.capturedEnvironmentContents = fs.readFileSync(environmentFile, "utf8");
    this.capturedEnvironmentMode = fs.statSync(environmentFile).mode & 0o777;
    const configuredResult = this.createResult;
    const labels = Object.fromEntries(
      args
        .map((argument, index) => ({ argument, label: args[index + 1] ?? "" }))
        .filter(({ argument }) => argument === "--label")
        .map(({ label }) => ({ label, separator: label.indexOf("=") }))
        .filter(({ separator }) => separator > 0)
        .map(({ label, separator }) => [label.slice(0, separator), label.slice(separator + 1)]),
    );
    switch (configuredResult) {
      case null:
        this.replacement = {
          id: REPLACEMENT_RUNTIME_ID,
          name: STAGING_NAME,
          image: REPLACEMENT_IMAGE_ID,
          labels: { ...this.replacementImageLabels, ...labels },
          entrypoint: ENTRYPOINT_ARGV,
          command: COMMAND_ARGV,
          environment: this.replacementEnvironment,
          mounts: [
            {
              Destination: PODMAN_BOOTSTRAP_STATE_DIRECTORY,
              Driver: "local",
              Mode: this.stateVolumeMountMode,
              Name: STATE_VOLUME_NAME,
              Options: ["rw"],
              Propagation: "",
              RW: true,
              Source: STATE_VOLUME_MOUNTPOINT,
              Type: "volume",
            },
          ],
          running: this.replacementStartsOnCreate,
        };
        return this.result(`${REPLACEMENT_RUNTIME_ID}\n`);
      default:
        return configuredResult;
    }
  }

  private inspectContainer(args: readonly string[]): ContainerEngineCommandResult {
    const runtimeId = args[2];
    const failOnce = runtimeId === this.replacement?.id && this.failReplacementInspectOnce;
    switch (failOnce) {
      case true:
        this.failReplacementInspectOnce = false;
        return this.result("", { status: 125, error: new Error("inspect interrupted") });
    }
    const container =
      runtimeId === this.original.id && this.originalExists
        ? this.original
        : runtimeId === this.replacement?.id
          ? this.replacement
          : null;
    return container
      ? this.result(this.inspectOutput(container))
      : this.result("", { status: 125, error: new Error("container absent") });
  }
}
