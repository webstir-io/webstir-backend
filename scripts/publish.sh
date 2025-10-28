#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/publish.sh <patch|minor|major|x.y.z>

Examples:
  scripts/publish.sh patch
  scripts/publish.sh 0.1.0

The script requires a clean git worktree and an npm login to
https://npm.pkg.github.com with write:packages access.
EOF
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

main() {
  if [[ $# -lt 1 ]]; then
    echo "error: version bump argument missing" >&2
    usage
  fi

  local bump="$1"
  if [[ ! $bump =~ ^(patch|minor|major)$ && ! $bump =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "error: invalid bump '$bump'" >&2
    usage
  fi

  ensure_clean_git
  ensure_npm_login

  cd "$ROOT_DIR"

  echo "› npm version $bump"
  npm version "$bump"

  echo "› npm run build"
  npm run build

  echo "› npm test"
  npm test

  echo "› npm run smoke"
  npm run smoke

  echo "› npm publish --registry=https://npm.pkg.github.com"
  npm publish --registry="https://npm.pkg.github.com"

  echo
  # If running in CI or without a TTY, skip the interactive prompt.
  if [[ -n "${CI:-}" || ! -t 0 ]]; then
    if [[ "${PUBLISH_AUTO_PUSH:-}" =~ ^([Yy][Ee][Ss]|[Yy]|1|true)$ ]]; then
      echo "› git push"
      git push
      echo "› git push --tags"
      git push --tags
    else
      echo "No TTY detected; skipping git push prompt."
      echo "Set PUBLISH_AUTO_PUSH=1 to push commit and tags automatically."
    fi;
    return 0
  fi

  # Interactive shell: ask the user.
  read -r -p "Push git commit and tag upstream? [y/N]: " reply || true
  if [[ "$reply" =~ ^[Yy](es)?$ ]]; then
    echo "› git push"
    git push
    echo "› git push --tags"
    git push --tags
  else
    echo "Skipping push. To publish upstream later, run:"
    echo "  git push && git push --tags"
  fi
}

ensure_clean_git() {
  cd "$ROOT_DIR"
  if ! git diff --quiet --ignore-submodules HEAD; then
    echo "error: git worktree has uncommitted changes" >&2
    exit 1
  fi
  if ! git diff --quiet --cached --ignore-submodules; then
    echo "error: git index has staged changes" >&2
    exit 1
  fi
}

ensure_npm_login() {
  if ! npm whoami --registry="https://npm.pkg.github.com" >/dev/null 2>&1; then
    cat >&2 <<'EOF'
error: not authenticated with https://npm.pkg.github.com.
Run: npm login --registry=https://npm.pkg.github.com --scope=@webstir-io
EOF
    exit 1
  fi
}

main "$@"
