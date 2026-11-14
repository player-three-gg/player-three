#!/usr/bin/env bash
# Fresh-history public snapshot: one parentless commit holding exactly the tracked tree of <source-ref>.
#
#   scripts/public-snapshot.sh [--dry-run | --create] [--branch NAME] [--version X.Y.Z] [--author-email EMAIL] <source-ref> <target-url>
#
# --dry-run (default) builds the commit object and verifies its tree but creates no ref.
# --create also points <branch> (default public/main) at the snapshot commit.
# --author-email sets author and committer email for this commit only (use the GitHub noreply address);
# the name, and the email when omitted, come from local git config. Never pushes: it prints the push command.
# The tree must pass scripts/check-public.mjs first, and the commit's author and committer dates are the moment
# the snapshot is taken, never a date from the source history.
set -euo pipefail

PRODUCT='PlayerThree'
mode=dry-run
branch=public/main
version=0.1.0
author_email=

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

args=()
while (($#)); do
  case "$1" in
    --dry-run) mode=dry-run ;;
    --create) mode=create ;;
    --branch) branch=${2:?--branch needs a name}; shift ;;
    --version) version=${2:?--version needs a value}; shift ;;
    --author-email) author_email=${2:?--author-email needs a value}; shift ;;
    -h|--help) usage ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *) args+=("$1") ;;
  esac
  shift
done
((${#args[@]} == 2)) || usage
source_ref=${args[0]}
target=${args[1]}

name=$(git config user.name) || { echo 'git config user.name is not set' >&2; exit 1; }
email=${author_email:-$(git config user.email)} || { echo 'git config user.email is not set' >&2; exit 1; }

source_commit=$(git rev-parse --verify "${source_ref}^{commit}")
source_tree=$(git rev-parse "${source_commit}^{tree}")

# Nothing in the public tree may say when, or over what period, the work was done.
node "$(dirname "$0")/check-public.mjs" --ref "$source_commit" --summary || {
  echo "refusing to snapshot: run node scripts/check-public.mjs --ref $source_ref and fix every finding" >&2
  exit 1
}

snapshot_date=$(date -u +%Y-%m-%dT%H:%M:%SZ)
commit=$(GIT_AUTHOR_NAME=$name GIT_AUTHOR_EMAIL=$email GIT_AUTHOR_DATE=$snapshot_date \
  GIT_COMMITTER_NAME=$name GIT_COMMITTER_EMAIL=$email GIT_COMMITTER_DATE=$snapshot_date \
  git commit-tree "$source_tree" -m "$PRODUCT $version")

snapshot_tree=$(git rev-parse "${commit}^{tree}")
parents=$(git rev-list --parents -n 1 "$commit" | wc -w)
if [[ $snapshot_tree != "$source_tree" || $parents != 1 ]]; then
  echo "snapshot mismatch: tree $snapshot_tree vs $source_tree, parent count $((parents - 1))" >&2
  exit 1
fi

echo "source   $source_ref = $source_commit"
echo "tree     $source_tree (snapshot tree matches)"
echo "commit   $commit \"$PRODUCT $version\" by $name <$email>, dated $snapshot_date, no parents"

if [[ $mode == create ]]; then
  if git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
    echo "branch $branch already exists; delete it or pass --branch" >&2
    exit 1
  fi
  git update-ref "refs/heads/$branch" "$commit" ''
  echo "branch   $branch -> $commit"
  echo
  echo "Push (not run):"
  echo "  git push $target $branch:main"
else
  echo
  echo "Dry run: no ref created. Re-run with --create, then push (not run):"
  echo "  git push $target $branch:main"
fi
