// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Command, Flags } from "@oclif/core";
import type { PublicCommandDisplayEntry } from "../lib/cli/command-display";
import { runKubernetesPilot } from "../lib/actions/kubernetes/pilot";

export default class KubernetesCommand extends Command {
  static id = "kubernetes";
  static strict = false;
  static summary = "Manage an explicitly bound Kubernetes pilot gateway (experimental fork)";
  static usage = ["kubernetes <action> [name] --target FILE [--provider NAME] [-- COMMAND...]"];
  static publicDisplay: PublicCommandDisplayEntry[] = [
    {
      usage: "nemoclaw kubernetes <action> [name]",
      description: "Manage a bound Kubernetes pilot (experimental fork)",
      group: "Sandbox Management",
      scope: "global",
      order: 19.5,
      hidden: true,
    },
  ];
  static args = {
    action: Args.string({
      required: true,
      options: ["status", "list", "create", "get", "start", "stop", "exec"],
    }),
    name: Args.string(),
  };
  static flags = {
    target: Flags.string({
      required: true,
      description: "Non-secret, identity-bound Kubernetes target JSON",
    }),
    provider: Flags.string({ description: "Already registered provider name; never a credential" }),
  };

  async run(): Promise<void> {
    const separator = this.argv.indexOf("--");
    const command = separator < 0 ? [] : this.argv.slice(separator + 1);
    const { args, flags, argv } = await this.parse(KubernetesCommand);
    if (argv.length > (args.name ? 2 : 1) + command.length)
      this.error("Unexpected positional arguments");
    runKubernetesPilot(flags.target, args.action, args.name, command, flags.provider);
  }
}
