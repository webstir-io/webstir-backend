#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/publish.sh <patch|minor|major|x.y.z> [--no-push]

Examples:
  scripts/publish.sh patch
  scripts/publish.sh 0.1.0

The script requires a clean git worktree and an npm login to
https://npm.pkg.github.com with write:packages access.

By default, the script pushes the version bump commit and tag. To skip pushing,
pass --no-push or set PUBLISH_NO_PUSH=1.
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

  local bump="$1"; shift || true
  local no_push="false"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-push)
        no_push="true"
        ;;
      *)
        echo "error: unknown option '$1'" >&2
        usage
        ;;
    esac
    shift || true
  done

  if [[ ! $bump =~ ^(patch|minor|major)$ && ! $bump =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "error: invalid bump '$bump'" >&2
    usage
  fi

  ensure_clean_git

  cd "$ROOT_DIR"

  echo "› npm version $bump"
  npm version "$bump" -m "v%s"

  echo "› npm install --package-lock-only"
  npm install --package-lock-only

  echo "› npm run clean"
  npm run clean

  echo "› npm run build"
  npm run build

  echo "› npm test"
  npm test

  echo "› npm run smoke"
  npm run smoke

  echo "› Skipping direct npm publish; pushing commit+tag will trigger the release workflow."

  if [[ "$no_push" == "true" || "${PUBLISH_NO_PUSH:-}" =~ ^([Yy][Ee][Ss]|[Yy]|1|true)$ ]]; then
    echo "› Skipping git push (no-push)."
    echo "  To publish upstream later, run: git push && git push --tags"
    return 0
  fi

  echo "› git push"
  git push
  echo "› git push --tags"
  git push --tags
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

main "$@"
