#!/bin/sh
# Sandbox sshd: stable host keys from a volume, one authorized key from $PUBLIC_KEY, then sshd.
set -eu

user="${USER_NAME:-sandbox}"
keydir=/etc/ssh/hostkeys
mkdir -p "$keydir" /run/sshd

if [ ! -f "$keydir/ssh_host_ed25519_key" ]; then
  ssh-keygen -q -t ed25519 -N "" -C "pengupool-ssh-sandbox" -f "$keydir/ssh_host_ed25519_key"
fi
chmod 600 "$keydir/ssh_host_ed25519_key"
chmod 644 "$keydir/ssh_host_ed25519_key.pub"

if [ -n "${PUBLIC_KEY:-}" ]; then
  mkdir -p "/home/$user/.ssh"
  printf '%s\n' "$PUBLIC_KEY" > "/home/$user/.ssh/authorized_keys"
  chmod 700 "/home/$user/.ssh"
  chmod 600 "/home/$user/.ssh/authorized_keys"
  chown -R "$user:$user" "/home/$user/.ssh"
fi

echo "[sandbox] host key fingerprint: $(ssh-keygen -lf "$keydir/ssh_host_ed25519_key.pub" | awk '{print $2}')"
exec /usr/sbin/sshd -D -e
