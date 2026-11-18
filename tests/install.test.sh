#!/bin/sh
# Checks the installer against throwaway Herdr homes. Needs the Herdr app for
# `herdr-app check`; runs on macOS, Linux and Git Bash.
#
#   sh tests/install.test.sh
set -eu

here=$(cd "$(dirname "$0")/.." && pwd -P)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
trap 'echo "FAIL: unexpected exit"; exit 1' INT TERM

pass=0
fail() { echo "FAIL: $1"; exit 1; }
ok() { pass=$((pass + 1)); echo "  ok  $1"; }

# The installer wants the Herdr app for `herdr-app check`; elsewhere a stub does.
if ! command -v herdr-app >/dev/null 2>&1; then
  mkdir -p "$tmp/bin"
  printf '#!/bin/sh\nexit 0\n' >"$tmp/bin/herdr-app"
  chmod +x "$tmp/bin/herdr-app"
  PATH="$tmp/bin:$PATH"
  echo "  (no herdr-app here: using a stub, so mods are not really checked)"
fi

# A copy of the repository, so a test can break one file without touching the real one.
repo=$tmp/repo
mkdir -p "$repo"
(cd "$here" && tar -cf - --exclude .git .) | (cd "$repo" && tar -xf -)

fresh_home() {
  rm -rf "$tmp/home"
  mkdir -p "$tmp/home"
}

run() {
  HERDR_APP_HOME=$tmp/home sh "$repo/install.sh" "$@"
}

# ---- a fresh install writes what install.tsv lists ---------------------------
fresh_home
out=$(run 2>&1) || fail "fresh install exited non-zero: $out"
for path in themes/farrier.json layouts/farrier.json layouts/farrier.svg mods/farrier/main.js mods/farrier-git/main.js; do
  [ -e "$tmp/home/$path" ] || fail "fresh install missed $path"
done
ok "fresh install writes every row"

# ---- a second run changes nothing -------------------------------------------
out=$(run --dry-run 2>&1) || fail "second dry run exited non-zero"
echo "$out" | grep -q '  + ' && fail "dry run of an installed tree still plans writes: $out"
ok "second run is a no-op"

# ---- a changed file is replaced, and the old one is kept ---------------------
printf '\n' >>"$repo/themes/farrier.json"
out=$(run --dry-run 2>&1)
echo "$out" | grep -q '~ themes/farrier.json' || fail "changed theme was not planned for replacement: $out"
out=$(run 2>&1) || fail "update exited non-zero: $out"
[ -d "$tmp/home/backup" ] || fail "update kept no backup"
ok "changed file is replaced with a backup"

# ---- Herdr's own names are refused -----------------------------------------
fresh_home
awk -F'\t' 'BEGIN{OFS="\t"} $1=="farrier-mod"{$4="mods/tabs"} {print}' "$repo/install.tsv" >"$repo/install.tsv.new"
mv "$repo/install.tsv.new" "$repo/install.tsv"
out=$(run 2>&1) && fail "a shipped mod name was accepted"
echo "$out" | grep -q "Herdr ships" || fail "the refusal did not name the reason: $out"
[ ! -e "$tmp/home/mods/tabs" ] || fail "a refused install wrote files anyway"
ok "a name Herdr ships is refused before writing"

# ---- a broken theme is refused ---------------------------------------------
(cd "$here" && tar -cf - --exclude .git themes install.tsv) | (cd "$repo" && tar -xf -)
fresh_home
node -e '
const fs=require("fs");
const p=process.argv[1];
const t=JSON.parse(fs.readFileSync(p,"utf8"));
t.ansi.pop();
fs.writeFileSync(p, JSON.stringify(t,null,2));
' "$repo/themes/farrier.json" 2>/dev/null || sed -i 's/"#f2ece4"//' "$repo/themes/farrier.json"
if command -v python3 >/dev/null 2>&1; then
  out=$(run 2>&1) && fail "a 15-color theme was accepted"
  ok "a broken theme is refused (python3 present)"
else
  out=$(run --dry-run 2>&1) || fail "dry run failed without python3: $out"
  ok "broken theme passes without python3 (shape not checked there)"
fi

# ---- uninstall takes out what it put in, and leaves the rest ----------------
(cd "$here" && tar -cf - --exclude .git themes) | (cd "$repo" && tar -xf -)
fresh_home
run >/dev/null 2>&1 || fail "install before remove failed"
echo '{"keep":true}' >"$tmp/home/settings.json"
run --remove >/dev/null 2>&1 || fail "remove exited non-zero"
for path in themes/farrier.json layouts/farrier.json mods/farrier mods/farrier-git; do
  [ ! -e "$tmp/home/$path" ] || fail "remove left $path behind"
done
[ -f "$tmp/home/settings.json" ] || fail "remove touched settings.json"
ok "remove takes back only what Farrier installed"

# ---- unknown id and a missing home are refused ------------------------------
out=$(run nope 2>&1) && fail "an unknown id was accepted"
HERDR_APP_HOME=$tmp/nothing sh "$repo/install.sh" >/dev/null 2>&1 && fail "a missing home was accepted"
ok "unknown id and missing home are refused"

echo ""
echo "$pass checks passed"
