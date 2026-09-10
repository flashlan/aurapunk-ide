#!/usr/bin/env bash

set -Eeuo pipefail

REPOSITORY="flashlan/aurapunk-ide"
DOWNLOAD_BASE="https://github.com/${REPOSITORY}/releases/latest/download"
APPLICATION_NAME="Aurapunk IDE"

die() {
  printf 'Aurapunk IDE installer: %s\n' "$*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || die "curl is required."

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aurapunk-install.XXXXXX")"
MOUNT_POINT="$TEMP_DIR/mount"
MOUNTED=0

cleanup() {
  if [ "$MOUNTED" -eq 1 ]; then
    hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

download_asset() {
  local asset="$1"
  local destination="$2"
  printf 'Downloading %s...\n' "$asset"
  curl --fail --location --retry 3 --retry-delay 2 --silent --show-error \
    "${DOWNLOAD_BASE}/${asset}" --output "$destination"
}

install_macos() {
  local architecture
  architecture="$(uname -m)"

  local asset
  case "$architecture" in
    arm64) asset="Aurapunk-IDE-macos-apple-silicon.dmg" ;;
    x86_64) asset="Aurapunk-IDE-macos-intel.dmg" ;;
    *) die "Unsupported macOS architecture: $architecture" ;;
  esac

  command -v hdiutil >/dev/null 2>&1 || die "hdiutil is required on macOS."
  mkdir -p "$MOUNT_POINT"
  download_asset "$asset" "$TEMP_DIR/Aurapunk-IDE.dmg"
  hdiutil attach "$TEMP_DIR/Aurapunk-IDE.dmg" \
    -nobrowse -readonly -mountpoint "$MOUNT_POINT" >/dev/null
  MOUNTED=1

  local application
  application="$(find "$MOUNT_POINT" -maxdepth 2 -name '*.app' -print -quit)"
  [ -n "$application" ] || die "The DMG does not contain an application bundle."

  printf 'Installing %s into /Applications...\n' "$APPLICATION_NAME"
  if [ -w /Applications ]; then
    ditto "$application" "/Applications/${APPLICATION_NAME}.app"
    xattr -cr "/Applications/${APPLICATION_NAME}.app" 2>/dev/null || true
  else
    sudo ditto "$application" "/Applications/${APPLICATION_NAME}.app"
    sudo xattr -cr "/Applications/${APPLICATION_NAME}.app" 2>/dev/null || true
  fi

  printf 'Installed %s. You can open it from Applications or Spotlight.\n' "$APPLICATION_NAME"
}

install_linux() {
  [ "$(uname -m)" = "x86_64" ] || die "This release currently provides a Linux x86_64 AppImage."

  local install_dir="${AURAPUNK_INSTALL_DIR:-${HOME}/.local/bin}"
  local binary_path="${install_dir}/aurapunk-ide"
  mkdir -p "$install_dir"
  download_asset "Aurapunk-IDE-linux-x64.AppImage" "$binary_path"
  chmod 755 "$binary_path"

  local applications_dir="${XDG_DATA_HOME:-${HOME}/.local/share}/applications"
  mkdir -p "$applications_dir"
  cat > "${applications_dir}/aurapunk-ide.desktop" <<DESKTOP
[Desktop Entry]
Name=${APPLICATION_NAME}
Comment=AI-powered development workspace
Exec=${binary_path}
Terminal=false
Type=Application
Categories=Development;IDE;
DESKTOP

  printf 'Installed %s at %s\n' "$APPLICATION_NAME" "$binary_path"
  printf 'Run it with: %s\n' "$binary_path"
}

case "$(uname -s)" in
  Darwin) install_macos ;;
  Linux) install_linux ;;
  *) die "Supported systems are macOS and Linux." ;;
esac
