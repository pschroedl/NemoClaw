# SPDX-License-Identifier: Apache-2.0

ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox@sha256:25634ef3d6f4e0e1aba30397c4a7ae56cc5f9d020fd5888318c24fcd073ffea9
FROM ${BASE_IMAGE}

USER root
ADD --checksum=sha256:edf79108dbd1d6e7714ad282d5931a2f39bb81d7f1c9dc13a994ffa90435095e \
  https://registry.npmjs.org/opencode-linux-x64-baseline/-/opencode-linux-x64-baseline-1.18.31.tgz \
  /tmp/opencode.tgz
RUN install -d -o root -g root -m 0755 /opt/opencode \
  && tar -xzf /tmp/opencode.tgz -C /opt/opencode --strip-components=1 \
  && rm /tmp/opencode.tgz \
  && install -o root -g root -m 0755 /opt/opencode/bin/opencode /usr/local/bin/opencode \
  && test "$(/usr/local/bin/opencode --version)" = '1.18.31'
COPY opencode-nemoclaw /usr/local/bin/opencode-nemoclaw
COPY opencode.json /usr/local/share/nemoclaw/opencode.json
RUN chown root:root /usr/local/bin/opencode-nemoclaw /usr/local/share/nemoclaw/opencode.json \
  && chmod 0755 /usr/local/bin/opencode-nemoclaw \
  && chmod 0444 /usr/local/share/nemoclaw/opencode.json
USER sandbox
