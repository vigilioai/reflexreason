#!/usr/bin/env bash
# Set the project version everywhere it is written, rebuild the tutorial,
# and print the git commands that make the release. Pushes nothing.
#
#   scripts/80-release.sh 1.0.1
#
# The version is written in four places: ts/package.json, its lock file,
# the [workspace.package] table of rust/Cargo.toml, and the entries of the
# workspace's own crates in rust/Cargo.lock. The tag workflow
# (.github/workflows/tutorial.yml) refuses a tag that does not match them.
set -euo pipefail
cd "$(dirname "$0")/.."

new="${1:?usage: scripts/80-release.sh X.Y.Z}"
if [[ ! "$new" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "not a SemVer version: $new" >&2
  exit 2
fi
if git rev-parse -q --verify "refs/tags/v$new" >/dev/null 2>&1; then
  echo "tag v$new already exists" >&2
  exit 2
fi

python3 - "$new" <<'PY'
import json
import pathlib
import re
import sys

new = sys.argv[1]
for name in ("ts/package.json", "ts/package-lock.json"):
    path = pathlib.Path(name)
    data = json.loads(path.read_text())
    data["version"] = new
    if "" in data.get("packages", {}):
        data["packages"][""]["version"] = new
    # npm's own layout: two-space indent, literal UTF-8, final newline
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")

cargo = pathlib.Path("rust/Cargo.toml")
text = cargo.read_text()
head, table, rest = text.partition("[workspace.package]")
rest, n = re.subn(r'(?m)^version\s*=\s*"[^"]*"', f'version = "{new}"', rest,
                  count=1)
if not table or n != 1:
    sys.exit("rust/Cargo.toml: no version in [workspace.package]")
cargo.write_text(head + table + rest)

members = [
    re.search(r'(?m)^name\s*=\s*"([^"]+)"',
              (pathlib.Path("rust") / m / "Cargo.toml").read_text()).group(1)
    for m in re.findall(r'"(crates/[^"]+)"', head)
]
lock = pathlib.Path("rust/Cargo.lock")
text = lock.read_text()
for name in members:
    text, n = re.subn(
        rf'(\[\[package\]\]\nname = "{re.escape(name)}"\nversion = )"[^"]*"',
        rf'\g<1>"{new}"', text)
    if n != 1:
        sys.exit(f"rust/Cargo.lock: expected one entry for {name}, found {n}")
lock.write_text(text)
print(f"version {new} written to ts/package.json, ts/package-lock.json, "
      f"rust/Cargo.toml and rust/Cargo.lock ({', '.join(members)})")
PY

python3 docs/build_tutorial.py
cat <<EOF

Check the change with git diff, then:
  git commit -am "Release $new"
  git tag -a v$new -m "Holsti $new"
  git push --follow-tags
EOF
