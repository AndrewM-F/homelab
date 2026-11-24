#!/bin/bash
# Back up omarchy's configuration, not its bulk.
#
# The workstation holds 168 GB, but almost all of it is git repos, toolchains and
# caches that can be re-cloned or re-fetched. This captures the part that makes a
# rebuild painful: system config, dotfiles, package manifests.
#
# The archive is pushed to the hypervisor's dump storage, because storing it on
# the machine it describes protects nothing.
#
# Install on omarchy:
#   install -m 0755 omarchy-config-backup.sh /usr/local/sbin/
#   install -m 0644 omarchy-config-backup.* /etc/systemd/system/
#   printf 'REMOTE=root@10.0.0.10\n' > /etc/homelab-backup.env   # your backup host
#   systemctl daemon-reload && systemctl enable --now omarchy-config-backup.timer

set -euo pipefail

REMOTE=${REMOTE:?set REMOTE to the backup target, e.g. root@10.0.0.10}
KEY=${KEY:-$HOME/.ssh/id_ed25519}
DEST=${DEST:-/var/lib/vz/dump}
KEEP=${KEEP:-7}
HOME_DIR=${HOME_DIR:-$HOME}
STAMP=$(date +%Y%m%d-%H%M)
NAME="omarchy-config-$STAMP.tar.zst"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Manifests first: these rebuild the machine even with the tarball unreadable.
pacman -Qqe > "$WORK/packages-explicit.txt" 2>/dev/null || true
pacman -Qqm > "$WORK/packages-aur.txt" 2>/dev/null || true
systemctl list-unit-files --state=enabled --no-legend --no-pager \
  > "$WORK/units-enabled.txt" 2>/dev/null || true
fc-list : family 2>/dev/null | sort -u > "$WORK/fonts.txt" || true

# Config only. Application profiles under ~/.config are caches in disguise —
# Claude/Codex/chromium/zen/mozilla alone are 1.5 GB of it.
tar --zstd -cf "$WORK/config.tar.zst" \
  --warning=no-file-changed \
  --exclude='etc/ssh/ssh_host_*' \
  --exclude='.config/Claude' \
  --exclude='.config/Codex' \
  --exclude='.config/chromium' \
  --exclude='.config/zen' \
  --exclude='.config/mozilla' \
  --exclude='*.log' \
  -C / etc \
  -C "$HOME_DIR" \
    .bashrc .bash_profile .profile .zshrc .zshenv .gitconfig .ssh \
    .config/systemd .config/omarchy .config/hypr .config/alacritty .config/foot \
    .config/kitty .config/starship.toml .config/nvim .local/bin \
  2>/dev/null || true

tar -cf - -C "$WORK" . | ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$REMOTE" \
  "mkdir -p $DEST && cat > $DEST/$NAME.partial && mv $DEST/$NAME.partial $DEST/$NAME && chmod 600 $DEST/$NAME"

ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$REMOTE" \
  "ls -1t $DEST/omarchy-config-*.tar.zst 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f"

echo "$(date -Is) omarchy-config: $NAME $(ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$REMOTE" "stat -c%s $DEST/$NAME") bytes"
