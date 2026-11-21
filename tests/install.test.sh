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
for path in themes/farrier-charcoal.json layouts/farrier.json layouts/farrier.svg mods/farrier/main.js mods/farrier-git/main.js mods/farrier-files/main.js; do
  [ -e "$tmp/home/$path" ] || fail "fresh install missed $path"
done
ok "fresh install writes every row"

# ---- a second run changes nothing -------------------------------------------
out=$(run --dry-run 2>&1) || fail "second dry run exited non-zero"
echo "$out" | grep -q '  + ' && fail "dry run of an installed tree still plans writes: $out"
ok "second run is a no-op"

# ---- a changed file is replaced, and the old one is kept ---------------------
printf '\n' >>"$repo/themes/farrier-charcoal.json"
out=$(run --dry-run 2>&1)
echo "$out" | grep -q '~ themes/farrier-charcoal.json' || fail "changed theme was not planned for replacement: $out"
out=$(run 2>&1) || fail "update exited non-zero: $out"
[ -d "$tmp/home/backup" ] || fail "update kept no backup"
ok "changed file is replaced with a backup"

# ---- explicit ids install the theme before the layout -----------------------
fresh_home
out=$(run --dry-run farrier-layout farrier-theme 2>&1) || fail "explicit dry run exited non-zero: $out"
first_theme=$(echo "$out" | grep -n 'themes/farrier-charcoal.json' | head -1 | cut -d: -f1)
first_layout=$(echo "$out" | grep -n 'layouts/farrier.json' | head -1 | cut -d: -f1)
[ "$first_theme" -lt "$first_layout" ] || fail "theme was not planned before the layout: $out"
ok "explicit ids install the theme before the layout"

# ---- an old layout and theme name are migrated on update ---------------------
fresh_home
run >/dev/null 2>&1 || fail "install before theme migration failed"
sed 's/"theme": "farrier-charcoal"/"theme": "farrier"/' "$tmp/home/layouts/farrier.json" >"$tmp/home/layouts/farrier.json.new"
mv "$tmp/home/layouts/farrier.json.new" "$tmp/home/layouts/farrier.json"
mv "$tmp/home/themes/farrier-charcoal.json" "$tmp/home/themes/farrier.json"
out=$(run --update --dry-run 2>&1) || fail "dry run of theme migration exited non-zero: $out"
echo "$out" | grep -q 'themes/farrier-charcoal.json' || fail "update did not plan the renamed theme: $out"
echo "$out" | grep -q -- '- themes/farrier.json' || fail "update did not plan to remove the old theme: $out"
out=$(run --update 2>&1) || fail "theme migration exited non-zero: $out"
[ -f "$tmp/home/themes/farrier-charcoal.json" ] || fail "update did not install the renamed theme"
[ ! -e "$tmp/home/themes/farrier.json" ] || fail "update left the old theme name behind"
grep -q '"theme": "farrier-charcoal"' "$tmp/home/layouts/farrier.json" || fail "update did not rewrite the layout's theme"
find "$tmp/home/backup" -path '*/themes/farrier.json' 2>/dev/null | grep -q . || fail "the old theme was not backed up"
ok "an old layout and theme name are migrated by update"

# ---- a theme-only update keeps the old file while the layout names it -------
fresh_home
run >/dev/null 2>&1 || fail "install before theme-only migration failed"
sed 's/"theme": "farrier-charcoal"/"theme": "farrier"/' "$tmp/home/layouts/farrier.json" >"$tmp/home/layouts/farrier.json.new"
mv "$tmp/home/layouts/farrier.json.new" "$tmp/home/layouts/farrier.json"
mv "$tmp/home/themes/farrier-charcoal.json" "$tmp/home/themes/farrier.json"
out=$(run --update farrier-theme 2>&1) || fail "theme-only update exited non-zero: $out"
[ -f "$tmp/home/themes/farrier-charcoal.json" ] || fail "theme-only update did not install the new theme"
[ -f "$tmp/home/themes/farrier.json" ] || fail "theme-only update removed the old theme while the layout names it"
grep -q '"theme": "farrier"' "$tmp/home/layouts/farrier.json" || fail "theme-only update rewrote the layout"
ok "a theme-only update keeps the old theme"

# ---- a layout update brings the new theme and drops the old one -------------
out=$(run --update farrier-layout 2>&1) || fail "layout update exited non-zero: $out"
[ -f "$tmp/home/themes/farrier-charcoal.json" ] || fail "layout update did not install the new theme"
[ ! -e "$tmp/home/themes/farrier.json" ] || fail "layout update left the old theme behind"
grep -q '"theme": "farrier-charcoal"' "$tmp/home/layouts/farrier.json" || fail "layout update did not rewrite the layout's theme"
find "$tmp/home/backup" -path '*/themes/farrier.json' 2>/dev/null | grep -q . || fail "layout update did not back up the old theme"
ok "a layout update migrates the theme"

# ---- Herdr's own names are refused -----------------------------------------
fresh_home
awk -F'\t' 'BEGIN{OFS="\t"} $1=="farrier-mod"{$4="mods/tabs"} {print}' "$repo/install.tsv" >"$repo/install.tsv.new"
mv "$repo/install.tsv.new" "$repo/install.tsv"
out=$(run 2>&1) && fail "a shipped mod name was accepted"
echo "$out" | grep -q "Herdr ships" || fail "the refusal did not name the reason: $out"
[ ! -e "$tmp/home/mods/tabs" ] || fail "a refused install wrote files anyway"
ok "a name Herdr ships is refused before writing"

# ---- a theme name Herdr ships is refused ------------------------------------
(cd "$here" && tar -cf - --exclude .git themes install.tsv) | (cd "$repo" && tar -xf -)
cp "$repo/themes/farrier-charcoal.json" "$repo/themes/atom-one-dark.json"
awk -F'\t' 'BEGIN{OFS="\t"} $1=="farrier-theme"{$3="themes/atom-one-dark.json";$4="themes/atom-one-dark.json"} {print}' "$repo/install.tsv" >"$repo/install.tsv.new"
mv "$repo/install.tsv.new" "$repo/install.tsv"
fresh_home
out=$(run --dry-run 2>&1) && fail "a theme name Herdr ships was accepted"
echo "$out" | grep -q "Herdr ships" || fail "the refusal did not name the reason: $out"
ok "a theme name Herdr ships is refused before writing"

# ---- a theme with a layout's name is refused --------------------------------
(cd "$here" && tar -cf - --exclude .git themes install.tsv) | (cd "$repo" && tar -xf -)
cp "$repo/themes/farrier-charcoal.json" "$repo/themes/farrier.json"
awk -F'\t' 'BEGIN{OFS="\t"} $1=="farrier-theme"{$3="themes/farrier.json";$4="themes/farrier.json"} {print}' "$repo/install.tsv" >"$repo/install.tsv.new"
mv "$repo/install.tsv.new" "$repo/install.tsv"
fresh_home
out=$(run --dry-run 2>&1) && fail "a theme with a layout's name was accepted"
echo "$out" | grep -q "has a layout's name" || fail "the refusal did not name the reason: $out"
ok "a theme with a layout's name is refused before writing"

# ---- a broken theme is refused ---------------------------------------------
(cd "$here" && tar -cf - --exclude .git themes install.tsv) | (cd "$repo" && tar -xf -)
fresh_home
if command -v node >/dev/null 2>&1; then
  node -e '
const fs=require("fs");
const p=process.argv[1];
const t=JSON.parse(fs.readFileSync(p,"utf8"));
t.ansi.pop();
fs.writeFileSync(p, JSON.stringify(t,null,2));
' "$repo/themes/farrier-charcoal.json"
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$repo/themes/farrier-charcoal.json" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    theme = json.load(f)
theme["ansi"].pop()
with open(path, "w") as f:
    json.dump(theme, f, indent=2)
PY
fi
if command -v python3 >/dev/null 2>&1; then
  out=$(run 2>&1) && fail "a 15-color theme was accepted"
  ok "a broken theme is refused (python3 present)"
else
  out=$(run --dry-run 2>&1) || fail "dry run failed without python3: $out"
  ok "broken theme passes without python3 (shape not checked there)"
fi

# ---- removing the Changes panel keeps the layout's key ---------------------
(cd "$here" && tar -cf - --exclude .git themes install.tsv) | (cd "$repo" && tar -xf -)
if command -v python3 >/dev/null 2>&1; then
  fresh_home
  run --keys >/dev/null 2>&1 || fail "install with keys failed"
  run --remove farrier-git >/dev/null 2>&1 || fail "remove of the Changes panel failed"
  grep -q 'layout:farrier' "$tmp/home/keys.json" || fail "removing the Changes panel removed the layout key"
  [ ! -e "$tmp/home/mods/farrier-git" ] || fail "remove left the Changes panel behind"
  ok "removing the Changes panel keeps the layout key"
else
  ok "removing the Changes panel keeps the layout key (not tested without python3)"
fi

# ---- a dry run names blocks, pane headers, floating blocks and toast --------
if command -v python3 >/dev/null 2>&1; then
  fresh_home
  run >/dev/null 2>&1 || fail "install before the extra-block check failed"
  python3 - "$tmp/home/layouts/farrier.json" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    layout = json.load(f)
layout["children"].append({"id": "extra-test", "type": "block",
                           "content": {"mod": "herdr-extra-test"}, "size": {"px": 200}})
layout["children"].append({"id": "extra-pane", "type": "block",
                           "content": {"tab": "active",
                                       "pane": {"header": {"content": {"mod": "herdr-extra-pane"}}}}})
layout["floating"] = [{"id": "extra-float", "content": {"mod": "herdr-extra-floating"}}]
layout["toast"] = "herdr-extra-toast"
with open(path, "w") as f:
    json.dump(layout, f, indent=2)
PY
  out=$(run --update --dry-run farrier-layout 2>&1) || fail "dry run with extra blocks exited non-zero: $out"
  for name in herdr-extra-test herdr-extra-pane herdr-extra-floating herdr-extra-toast; do
    echo "$out" | grep -q "$name" || fail "dry run did not name $name: $out"
  done
  echo "$out" | grep -q "also places mods" || fail "dry run did not use the plural: $out"
  grep -q "herdr-extra-test" "$tmp/home/layouts/farrier.json" || fail "dry run wrote the layout"
  out=$(run --update farrier-layout 2>&1) || fail "real update with extra blocks exited non-zero: $out"
  echo "$out" | grep -q "also places" && fail "real update printed the dry-run note: $out"
  ok "a dry run names blocks, pane headers, floating blocks and toast"
else
  ok "a dry run names extra blocks (not tested without python3)"
fi

# ---- a corrupt installed layout does not crash the dry run ------------------
if command -v python3 >/dev/null 2>&1; then
  fresh_home
  run >/dev/null 2>&1 || fail "install before the corrupt-layout check failed"
  printf '{broken
' >"$tmp/home/layouts/farrier.json"
  out=$(run --update --dry-run farrier-layout 2>&1) || fail "dry run with a corrupt layout exited non-zero: $out"
  echo "$out" | grep -q "could not be read" || fail "dry run did not say the layout could not be read: $out"
  echo "$out" | grep -q "Traceback" && fail "dry run printed a traceback: $out"
  ok "a corrupt installed layout does not crash the dry run"
else
  ok "corrupt installed layout (not tested without python3)"
fi

# ---- without python3 the dry run says the check was skipped -----------------
if command -v python3 >/dev/null 2>&1; then
  nopy=$tmp/nopy
  mkdir -p "$nopy"
  printf '#!/bin/sh
exit 0
' >"$nopy/herdr-app"
  chmod +x "$nopy/herdr-app"
  case $(uname -s) in
    MINGW*|MSYS*|CYGWIN*) no_py_path=$nopy:/usr/bin ;;
    *)
      for tool in awk sed grep wc paste basename dirname cat mkdir rm cp mv diff cmp date tr sort head tail find sh; do
        src=$(command -v "$tool" 2>/dev/null) || continue
        ln -sf "$src" "$nopy/$tool" 2>/dev/null || cp "$src" "$nopy/$tool"
      done
      no_py_path=$nopy
      ;;
  esac
  if PATH=$no_py_path command -v python3 >/dev/null 2>&1; then
    ok "no-python3 dry run (skipped: python3 is in the tool path)"
  else
  fresh_home
  run >/dev/null 2>&1 || fail "install before the no-python3 check failed"
  python3 - "$tmp/home/layouts/farrier.json" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    layout = json.load(f)
layout["children"].append({"id": "extra-test", "type": "block",
                           "content": {"mod": "herdr-extra-test"}})
with open(path, "w") as f:
    json.dump(layout, f, indent=2)
PY
    out=$(PATH=$no_py_path HERDR_APP_HOME=$tmp/home sh "$repo/install.sh" --update --dry-run farrier-layout 2>&1)       || fail "dry run without python3 exited non-zero: $out"
    echo "$out" | grep -q "no python3: blocks" || fail "dry run did not say the blocks were not checked: $out"
    ok "without python3 a dry run says the extra blocks were not checked"
  fi
else
  ok "no-python3 dry run (not tested without python3)"
fi

# ---- uninstall takes out what it put in, and leaves the rest ----------------
(cd "$here" && tar -cf - --exclude .git themes) | (cd "$repo" && tar -xf -)
fresh_home
run >/dev/null 2>&1 || fail "install before remove failed"
echo '{"keep":true}' >"$tmp/home/settings.json"
run --remove >/dev/null 2>&1 || fail "remove exited non-zero"
for path in themes/farrier-charcoal.json layouts/farrier.json mods/farrier mods/farrier-git mods/farrier-files; do
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
