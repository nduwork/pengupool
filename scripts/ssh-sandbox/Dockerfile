# A throwaway Linux "remote" for testing PenguPool over ssh.
#
# Deliberately stock: Debian stable with sshd, tmux, python3 and uv, and no harness CLIs. That is the
# state a fresh box is in, which is what the remote-sessions plan has to work against (see
# docs/remote-sessions-plan.md). Nothing here is PenguPool-specific on purpose — no PATH tweaks, no
# preinstalled backend — so `doctor`, the install path and the non-interactive-ssh PATH problem all
# behave the way they will on a real remote.
FROM debian:stable-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-server procps python3 python3-venv sudo tmux wget xclip \
 && rm -rf /var/lib/apt/lists/*

# uv, where `install.sh` puts it. Keeping it system-wide means the sandbox exercises the same
# `uv tool install` path a real remote takes, including where the binary ends up.
RUN curl -fsSL https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL=/usr/local/bin sh \
 && uv --version

ARG USER_NAME=sandbox
# `usermod -p '*'` matters: useradd leaves the account locked, and sshd refuses a locked account even
# for public-key auth ("User sandbox not allowed because account is locked"). `*` is not a valid hash,
# and PasswordAuthentication is off, so the account can still only be entered with the key.
RUN useradd --create-home --shell /bin/bash "$USER_NAME" \
 && usermod -p '*' "$USER_NAME" \
 && printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$USER_NAME" > "/etc/sudoers.d/$USER_NAME" \
 && chmod 0440 "/etc/sudoers.d/$USER_NAME" \
 && mkdir -p /run/sshd /etc/ssh/hostkeys

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 0755 /usr/local/bin/entrypoint

EXPOSE 2222
ENTRYPOINT ["/usr/local/bin/entrypoint"]
