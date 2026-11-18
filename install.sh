#!/bin/sh
# Farrier installer for macOS, Linux and Git Bash on Windows.
#   sh install.sh              install everything
#   sh install.sh --list       what there is
#   sh install.sh --dry-run    print, touch nothing
#   sh install.sh --update     only what is installed
#   sh install.sh --remove     take it all back out
#   sh install.sh --keys       add the layout's keys
#   sh install.sh farrier-mod  only these ids
#
# Copies real files into the Herdr home, never symlinks: Herdr's watcher ignores
# paths outside it. Files are replaced in place and kept under
# <home>/backup/<time>/; a mod folder is staged beside its destination and moved
# into place in one rename, so an open Herdr never sees a half-copied mod.
# Everything is validated before anything is written: ids, destinations, the
# names Herdr ships (reserved.txt), the JSON, and the mods a layout references.
set -eu

here=$(cd "$(dirname "$0")" && pwd -P)
TSV=$here/install.tsv
RESERVED=$here/reserved.txt
APP=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
VERSION=$(cat "$here/VERSION")
echo "Farrier $VERSION"

dry=0
update=0
remove=0
want_list=0
want_keys=0
selected=""
for arg in "$@"; do
  case $arg in
    --dry-run) dry=1 ;;
    --update) update=1 ;;
    --remove) remove=1 ;;
    --list) want_list=1 ;;
    --keys) want_keys=1 ;;
    -y|--yes) : ;;
    *) selected="$selected $arg" ;;
  esac
done

fail() {
  echo "$1" >&2
  echo "Nothing was written." >&2
  exit 1
}

[ -f "$TSV" ] || fail "install.tsv is missing next to this script."
[ -f "$RESERVED" ] || fail "reserved.txt is missing next to this script."

field() { awk -F'\t' -v id="$1" -v n="$2" '$1 == id { print $n }' "$TSV"; }
ids() { awk -F'\t' '!/^#/ && NF >= 2 { print $1 }' "$TSV"; }
reserved() { awk -F'\t' -v k="$1" -v n="$2" '$1 == k && $2 == n { print "yes" }' "$RESERVED"; }

has_python() { command -v python3 >/dev/null 2>&1; }

check_theme_json() {
  has_python || return 0
  python3 - "$1" <<'PY'
import json, re, sys
theme = json.load(open(sys.argv[1]))
for key in ("background", "foreground", "selection", "ansi"):
    if not theme.get(key):
        print(f"{sys.argv[1]} has no '{key}'", file=sys.stderr); raise SystemExit(1)
ansi = theme["ansi"]
if len(ansi) != 16:
    print(f"{sys.argv[1]}: ansi needs 16 colors, has {len(ansi)}", file=sys.stderr); raise SystemExit(1)
hexes = [("ansi", c) for c in ansi] + [(f"colors.{k}", v) for k, v in (theme.get("colors") or {}).items()]
for where, value in hexes:
    if not isinstance(value, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        print(f"{sys.argv[1]}: {where} is not #rrggbb: {value}", file=sys.stderr); raise SystemExit(1)
PY
}

layout_refs() {
  python3 - "$1" <<'PY'
import json, sys
def walk(node, out):
    if not node:
        return
    content = node.get("content") or {}
    if content.get("mod"):
        out.append(content["mod"])
    if node.get("terminal_menu"):
        out.append(node["terminal_menu"])
    for child in node.get("children", []):
        walk(child, out)
out = []
walk(json.load(open(sys.argv[1])), out)
print("\n".join(out))
PY
}

layout_preview() {
  python3 - "$1" <<'PY'
import json, sys
print(json.load(open(sys.argv[1])).get("preview") or "")
PY
}

# ---- validate, before anything is written -----------------------------------
seen=""
for id in $(ids); do
  kind=$(field "$id" 2)
  src=$(field "$id" 3)
  dest=$(field "$id" 4)
  [ -n "$kind" ] || fail "install.tsv: $id has no kind"
  [ -n "$dest" ] || fail "install.tsv: $id has no destination"
  case $kind in layout|theme|mod|file) ;; *) fail "install.tsv: $id has an unknown kind: $kind" ;; esac
  case $seen in *" $id "*) fail "install.tsv: $id appears twice" ;; esac
  seen="$seen $id "

  name=$(basename "$dest")
  place=$(dirname "$dest")
  case $kind in
    layout) [ "$place" = "layouts" ] || fail "install.tsv: $dest is not under layouts/ for a layout" ;;
    theme) [ "$place" = "themes" ] || fail "install.tsv: $dest is not under themes/ for a theme" ;;
    mod) [ "$place" = "mods" ] || fail "install.tsv: $dest is not under mods/ for a mod" ;;
    file) { [ "$place" = "layouts" ] || [ "$place" = "themes" ]; } || fail "install.tsv: $dest is not under layouts/ or themes/" ;;
  esac
  if [ "$kind" != "file" ] && [ -n "$(reserved "$kind" "$name")" ]; then
    fail "install.tsv: '$name' is a name Herdr ships; pick another one (reserved.txt)"
  fi

  if [ ! -e "$here/$src" ]; then
    fail "install.tsv: $id points at a missing source: $src"
  fi
  if [ "$kind" = "mod" ]; then
    [ -f "$here/$src/main.js" ] || fail "$src has no main.js"
    [ -f "$here/$src/mod.json" ] || fail "$src has no mod.json"
  fi
  if [ "$kind" = "theme" ]; then
    check_theme_json "$here/$src" || fail "$src is not a valid theme"
  fi
done

own_mods=$(awk -F'\t' '!/^#/ && $2 == "mod" { n = $4; sub(/.*\//, "", n); print n }' "$TSV")
for id in $(ids); do
  [ "$(field "$id" 2)" = "layout" ] || continue
  src=$(field "$id" 3)
  if ! has_python; then
    echo "  (no python3: the layout's JSON and its mods were not checked)" >&2
    continue
  fi
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$here/$src" 2>/dev/null \
    || fail "$src is not valid JSON"
  preview=$(layout_preview "$here/$src" | tr -d '\r')
  if [ -n "$preview" ] && [ ! -e "$here/$preview" ]; then
    fail "$src: preview '$preview' is missing"
  fi
  for ref in $(layout_refs "$here/$src" | tr -d '\r'); do
    if [ -n "$(printf '%s\n' "$own_mods" | grep -Fx "$ref")" ]; then
      continue
    fi
    if [ -n "$(reserved mod "$ref")" ]; then
      continue
    fi
    fail "$src uses mod '$ref', which is neither Farrier's nor a mod Herdr ships"
  done
done

# ---- selection ----------------------------------------------------------------
if [ "$want_list" = 1 ]; then
  for id in $(ids); do
    printf '  %-16s %-8s %s\n' "$id" "$(field "$id" 2)" "$(field "$id" 5)"
  done
  exit 0
fi

if [ -n "$selected" ]; then
  chosen=""
  for id in $selected; do
    [ -n "$(field "$id" 1)" ] || fail "Unknown id: $id (see --list)"
    chosen="$chosen $id"
  done
else
  chosen=$(ids)
fi

if [ "$update" = 1 ] && [ "$remove" = 0 ]; then
  keep=""
  for id in $chosen; do
    if [ -e "$APP/$(field "$id" 4)" ]; then
      keep="$keep $id"
    fi
  done
  chosen=$keep
  [ -n "$chosen" ] || fail "Nothing from Farrier is installed yet: run install.sh to pick."
fi

[ -d "$APP" ] || fail "No Herdr home at $APP. Open Herdr once, or set HERDR_APP_HOME to its folder."

HERDR=""
if command -v herdr-app >/dev/null 2>&1; then
  HERDR=$(command -v herdr-app)
elif [ -x "$HOME/.local/bin/herdr-app" ]; then
  HERDR=$HOME/.local/bin/herdr-app
fi
[ -n "$HERDR" ] || fail "herdr-app is not on PATH and not in ~/.local/bin. Install the Herdr app first (https://herdr.dev)."

stamp=$(date '+%Y%m%d-%H%M%S')
stage=$APP/.farrier-stage
backup=$APP/backup/$stamp

same_file() { cmp -s "$1" "$2"; }
same_tree() {
  if diff -r "$1" "$2" 2>/dev/null | grep -v -E 'gpui-kit\.d\.ts|herdr\.d\.ts|jsconfig\.json' | grep -q .; then
    return 1
  fi
  return 0
}
unchanged() {
  if [ -f "$1" ]; then same_file "$1" "$2"; else same_tree "$1" "$2"; fi
}

remove_keys() {
  has_python || { echo "  Remove the layout:farrier section from $APP/keys.json by hand."; return 0; }
  python3 - "$APP/keys.json" "$here/keys.pack.json" "$dry" <<'PY'
import json, os, shutil, sys

keys_path, pack_path, dry = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
if not os.path.exists(keys_path):
    raise SystemExit(0)
keys = json.load(open(keys_path))
pack = json.load(open(pack_path))
changed = 0
for section, binds in pack.items():
    have = keys.get(section)
    if not isinstance(have, dict):
        continue
    for key, action in binds.items():
        if have.get(key) != action:
            continue
        del have[key]
        changed += 1
        print(f"  - key {key}  ({section})")
    if not have:
        del keys[section]
if not changed:
    print("  = no key of ours left")
    raise SystemExit(0)
if dry:
    print("  (dry run: keys.json not written)")
    raise SystemExit(0)
shutil.copy2(keys_path, keys_path + ".bak")
with open(keys_path, "w") as f:
    json.dump(keys, f, indent=2)
    f.write("\n")
print("  ~ keys.json (the old one is keys.json.bak)")
PY
}

merge_keys() {
  if [ "$dry" = 1 ]; then
    echo "  (dry run: keys.json not written)"
    return 0
  fi
  if has_python; then
    python3 - "$APP/keys.json" "$here/keys.pack.json" <<'PY'
import json, os, shutil, sys

keys_path, pack_path = sys.argv[1], sys.argv[2]
keys = {}
if os.path.exists(keys_path):
    keys = json.load(open(keys_path))
pack = json.load(open(pack_path))
changed = 0
for section, binds in pack.items():
    have = keys.setdefault(section, {})
    for key, action in binds.items():
        if key in have:
            if have[key] != action:
                print(f"  ! {key} in {section} is {have[key]}, kept yours")
            continue
        have[key] = action
        changed += 1
        print(f"  + key {key} -> {action}  ({section})")
if not changed:
    print("  = keys already bound")
    raise SystemExit(0)
if os.path.exists(keys_path):
    shutil.copy2(keys_path, keys_path + ".bak")
with open(keys_path, "w") as f:
    json.dump(keys, f, indent=2)
    f.write("\n")
print("  ~ keys.json (the old one is keys.json.bak)")
PY
  else
    echo "  This layout's key is in keys.pack.json. Add it to $APP/keys.json by hand:"
    sed 's/^/    /' "$here/keys.pack.json"
  fi
}

# ---- remove -------------------------------------------------------------------
if [ "$remove" = 1 ]; then
  removed=0
  for id in $chosen; do
    dest=$APP/$(field "$id" 4)
    if [ ! -e "$dest" ]; then
      echo "  = $(field "$id" 4) (not there)"
      continue
    fi
    if [ "$dry" = 0 ]; then
      rm -rf "$dest"
    fi
    echo "  - $(field "$id" 4)"
    removed=$((removed + 1))
  done
  if [ "$want_keys" = 1 ] || [ "$removed" -gt 0 ]; then
    remove_keys
  fi
  if [ "$dry" = 0 ]; then
    echo ""
    echo "Removed $removed of $(echo "$chosen" | wc -w). Switch to another layout first if Farrier is the shown one."
  fi
  exit 0
fi

# ---- install ------------------------------------------------------------------
if [ "$dry" = 0 ]; then
  rm -rf "$stage"
  mkdir -p "$stage"
fi

changed=0
for id in $chosen; do
  src=$here/$(field "$id" 3)
  dest=$APP/$(field "$id" 4)
  if [ -e "$dest" ] && unchanged "$src" "$dest"; then
    echo "  = $(field "$id" 4)"
    continue
  fi
  changed=$((changed + 1))
  if [ "$dry" = 1 ]; then
    if [ -e "$dest" ]; then
      echo "  ~ $(field "$id" 4)  (the old one is kept)"
    else
      echo "  + $(field "$id" 4)"
    fi
    continue
  fi

  mkdir -p "$(dirname "$stage/$id")"
  if [ -f "$src" ]; then
    # A file is replaced in place: a file that is briefly missing is what makes
    # an on-screen layout re-apply without its theme.
    cp "$src" "$stage/$id"
    kept=$backup/$(field "$id" 4)
    mkdir -p "$(dirname "$kept")"
    if [ -e "$dest" ]; then
      cp "$dest" "$kept"
    fi
    mkdir -p "$(dirname "$dest")"
    cp "$stage/$id" "$dest"
  else
    cp -R "$src" "$stage/$id"
    kept=$backup/$(field "$id" 4)
    mkdir -p "$(dirname "$kept")"
    if [ -e "$dest" ]; then
      mv "$dest" "$kept"
    fi
    mkdir -p "$(dirname "$dest")"
    mv "$stage/$id" "$dest"
  fi
  echo "  + $(field "$id" 4)"
done

if [ "$dry" = 0 ]; then
  rm -rf "$stage"
fi

failed=""
if [ "$dry" = 0 ]; then
  for id in $chosen; do
    [ "$(field "$id" 2)" = "mod" ] || continue
    if ! "$HERDR" check "$APP/$(field "$id" 4)"; then
      failed="$failed $id"
    fi
  done
fi

if [ "$want_keys" = 1 ]; then
  merge_keys
fi

if [ "$dry" = 0 ]; then
  echo ""
  if [ "$changed" = 0 ]; then
    echo "Everything was already up to date."
  else
    echo "Next: open Herdr and pick farrier in Settings > Layout (Ctrl+Shift+L cycles layouts)."
  fi
  if [ "$want_keys" = 0 ]; then
    echo "      Add this layout's key with: sh install.sh --keys"
  fi
  if [ -d "$backup" ]; then
    echo "Replaced files are in $backup"
  fi
fi

if [ -n "$failed" ]; then
  echo "herdr-app check failed for:$failed" >&2
  exit 1
fi

if [ "$dry" = 0 ]; then
  echo "Done. Herdr reloads mods live."
fi
