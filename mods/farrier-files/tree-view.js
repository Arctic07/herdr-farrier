// Renders the Files tree, the Search section and the small in-panel menus.
// Handlers belong to the list or to ordinary controls outside the virtual
// renderer, never to a row.

import { div } from "gpui-kit";
import { v_flex, h_flex, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { contextSegments, replacementPreview } from "./search-logic.js";
import { formatNumber, splitPathInfo } from "./files-logic.js";
import { icon, toolButton, textButton, ghostButton, countBadge, sectionHeader, emptyNote } from "./ui.js";

const TREE_ID = "farrier-files-tree";
const SEARCH_ID = "farrier-files-search";
const TREE_ROW_HEIGHT = 28;

function rootName(path) {
  const normalized = String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized || "Files";
}

function filterInput(t, state, placeholder) {
  return h_flex()
    .h(28)
    .flex_none()
    .px(7)
    .gap(6)
    .items_center()
    .rounded(7)
    .bg(t.input)
    .border_1()
    .border_color(t.border)
    .child(icon("search", t.dim, 12))
    .child(div().flex_1().min_w(0).child(Input.new(state).size_full().text_size(11.5).text_color(t.foreground)));
}

export function renderTreePane(view, t, cx) {
  let pane = v_flex()
    .id("farrier-files")
    .relative()
    .size_full()
    .min_h(0)
    .bg(t.background)
    .rounded(8)
    .border_1()
    .border_color(t.border)
    .text_color(t.foreground)
    .text_size(12.5)
    .track_focus(view.handle)
    .key_context("FarrierFiles")
    .on_key_down((event, cx) => view.onTreeKey(event, cx))
    .on_mouse_down("right", (event, cx) => view.openContextMenuAt(event, cx))
    .child(
      h_flex()
        .id("farrier-files-header")
        .h(38)
        .flex_none()
        .px(8)
        .gap(6)
        .items_center()
        .border_b_1()
        .border_color(t.border)
        .child(
          toolButton(t, "farrier-files-explorer-toggle", view.sections.explorer ? "chevron-down" : "chevron-right", t.dim, view.sections.explorer ? "Collapse the tree" : "Open the tree", (c) => view.toggleSection("explorer", c)),
        )
        .child(icon("folder-open", t.muted, 13))
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(11)
            .font_semibold()
            .text_color(t.foreground)
            .child(rootName(view.root)),
        )
        .child(
          toolButton(t, "farrier-files-open-folder", "folder-open", t.dim, "Open the selected folder in the system file manager", (c) => view.openInFileManager(view.selectedPath || "", c)),
        )
        .child(
          toolButton(t, "farrier-files-copy-path", "copy", t.dim, "Copy the selected path", (c) => view.copySelectedPath(c), {
            disabled: !view.selectedPath,
          }),
        )
        .child(
          toolButton(t, "farrier-files-refresh", "refresh", view.loading ? t.accent : t.dim, "Refresh the file tree", (c) => view.refresh(c)),
        )
        .child(
          toolButton(t, "farrier-files-search-open", "search", view.sections.search ? t.accent : t.dim, "Search files", (c) => view.openSearch(c)),
        ),
    );

  if (view.sections.explorer) {
    pane = pane.child(
      h_flex()
        .id("farrier-files-filter-row")
        .flex_none()
        .mx(8)
        .mt(7)
        .mb(5)
        .child(div().flex_1().min_w(0).child(filterInput(t, view.filterInput, "Filter files"))),
    );
  }

  pane = pane.child(
    v_flex()
      .flex_1()
      .min_h(0)
      .when(!view.sections.explorer, (e) => e.flex_none().h(0))
      .when(view.sections.explorer, (e) => e.pb(6))
      .when(view.sections.explorer, (e) =>
        e.relative().child(
          v_virtual_list(
            TREE_ID,
            view.rows.length,
            TREE_ROW_HEIGHT,
            (index) => view.rows[index]?.path ?? String(index),
            (range) => view.rows.slice(range.start, range.end).map((row) => treeRow(view, row, t)),
          )
            .size_full()
            .on_item_click((key, c) => view.activateTreeRow(key, c))
            .on_item_secondary_click((key, event, c) => view.rememberTreeRow(key, event, c))
            .on_mouse_down("left", (_event, c) => view.handle.focus())
            .track_scroll(view.treeScroll),
        ),
      )
      .when(view.sections.explorer, (e) => e.child(Scrollbar.vertical(TREE_ID).absolute().inset_0()))
      .when(view.sections.explorer && !view.rows.length && !view.loading, (e) =>
        e.child(
          v_flex()
            .absolute()
            .inset_0()
            .items_center()
            .justify_center()
            .gap(6)
            .child(icon(view.lazy ? "folder" : "search", t.dim, 18))
            .child(emptyNote(t, view.error || (view.root ? (view.lazy ? "Open a folder to list it" : "No files here") : "No folder"), { center: true, p: 0 })),
        ),
      )
      .when(view.sections.explorer && view.loading, (e) =>
        e.child(div().absolute().top(8).left(12).text_size(10.5).text_color(t.dim).child("Loading…")),
      )
      .when(view.sections.explorer && view.limited, (e) =>
        e.child(div().absolute().bottom(4).left(10).right(10).text_size(10).text_color(t.dim).child("Tree limited; use the filter or Search")),
      ),
  );

  if (view.sections.search) pane = pane.child(renderSearchSection(view, t, cx));

  if (view.error && view.sections.explorer && view.rows.length) {
    pane = pane.child(
      h_flex()
        .mx(8)
        .mb(6)
        .p(6)
        .gap(6)
        .rounded(6)
        .bg(t.blocked + "18")
        .border_1()
        .border_color(t.blocked + "55")
        .child(icon("close", t.blocked, 11))
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.blocked).child(view.error))
        .child(toolButton(t, "farrier-files-error-close", "close", t.muted, "Dismiss", (c) => view.clearError(c), { size: 18, iconSize: 10 })),
    );
  }

  if (view.dialog) pane = pane.child(renderDialog(view, t, cx));
  if (view.menu) pane = pane.child(renderContextMenu(view, t, cx));
  return pane;
}

function treeRow(view, row, t) {
  const selected = view.selectedPath === row.path;
  const dirty = !row.dir && view.dirtyMap?.[view.fileKeyFor(row.path)] === true;
  const mark = view.marks?.[row.path];
  const guide = 8 + (row.depth - 1) * 16;
  let el = h_flex()
    .id(`farrier-files-row-${row.path}`)
    .relative()
    .w_full()
    .h(TREE_ROW_HEIGHT)
    .flex_none()
    .pl(8 + row.depth * 16)
    .pr(7)
    .gap(6)
    .items_center()
    .rounded(6)
    .cursor_pointer()
    .text_color(selected ? t.foreground : t.muted)
    .when(selected, (e) => e.bg(t.selected))
    .when(!view.menu, (e) => e.hover((h) => h.bg(selected ? t.selected : t.hover).text_color(t.foreground)))
    .when(row.dir && view.expanded.has(row.path), (e) => e.text_color(t.foreground))
    .when(Boolean(view.root), (e) => {
      try {
        return e.drag_paths([view.absoluteFor(row.path)], view.on ? { on: view.on } : undefined);
      } catch {
        return e;
      }
    });

  if (row.depth > 0) {
    el = el.child(div().absolute().left(guide).top(0).bottom(0).w(1).bg(t.border));
  }
  if (selected) {
    el = el.child(div().absolute().left(0).top(5).bottom(5).w(2).rounded(1).bg(t.accent));
  }
  el = el
    .child(
      row.dir
        ? icon(view.expanded.has(row.path) ? "chevron-down" : "chevron-right", t.dim, 11)
        : div().w(11).flex_none(),
    )
    .child(icon(row.dir ? (view.expanded.has(row.path) ? "folder-open" : "folder") : view.kindFor(row.path).icon, row.dir ? t.muted : t[view.kindFor(row.path).tone] ?? t.muted, 14))
    .child(
      div()
        .flex_1()
        .min_w(0)
        .truncate()
        .font_medium()
        .when(!row.dir && view.previewKeys?.has(view.fileKeyFor(row.path)), (e) => e.italic().text_color(t.dim))
        .when(row.hit, (e) => e.text_color(t.accent))
        .child(row.name),
    );

  if (mark) {
    el = el.child(
      div()
        .flex_none()
        .text_size(9.5)
        .font_semibold()
        .text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.ansi3)
        .child(mark),
    );
  }
  if (dirty) el = el.child(div().flex_none().w(5).h(5).rounded(3).bg(t.accent));
  return el;
}

export function renderSearchSection(view, t, cx) {
  const count = view.searchGroups.reduce((n, group) => n + group.matches.length, 0);
  let section = v_flex()
    .id("farrier-files-search-section")
    .flex_none()
    .h(view.searchHeight())
    .min_h(130)
    .when(!view.sections.explorer, (e) => e.flex_1().h("auto"))
    .border_t_1()
    .border_color(t.border)
    .child(
      sectionHeader(t, "farrier-files-search-section-toggle", "Search", true, (c) => view.toggleSection("search", c),
        h_flex()
          .gap(4)
          .items_center()
          .child(count ? countBadge(t, formatNumber(count)) : div())
          .child(
            toolButton(t, "farrier-files-search-section-close", "close", t.dim, "Close Search", (c) => view.toggleSection("search", c), { size: 18, iconSize: 10 }),
          ),
      ),
    );

  section = section.child(
    h_flex()
      .flex_none()
      .mx(8)
      .mb(5)
      .gap(5)
      .items_center()
      .child(
        toolButton(t, "farrier-files-search-replace-toggle", view.search.replaceOpen ? "chevron-down" : "chevron-right", t.dim, view.search.replaceOpen ? "Hide replace" : "Show replace", (c) => view.toggleSearchReplace(c), { size: 20, iconSize: 10 }),
      )
      .child(div().flex_1().min_w(0).child(filterInput(t, view.searchInput, "Search files")))
  );

  section = section.child(
    h_flex()
      .flex_none()
      .mx(8)
      .mb(5)
      .gap(4)
      .items_center()
      .child(ghostButton(t, "farrier-files-search-case", "Aa", (c) => view.toggleSearchOption("caseSensitive", c), { active: view.search.caseSensitive, tooltip: "Match case" }))
      .child(ghostButton(t, "farrier-files-search-word", "ab", (c) => view.toggleSearchOption("wholeWord", c), { active: view.search.wholeWord, tooltip: "Whole word" }))
      .child(ghostButton(t, "farrier-files-search-regex", ".*", (c) => view.toggleSearchOption("regex", c), { active: view.search.regex, tooltip: "Regular expression" }))
      .child(div().flex_1())
      .child(
        toolButton(t, "farrier-files-search-globs", "config", view.search.filtersOpen ? t.accent : t.dim, "Include or exclude files", (c) => view.toggleSearchFilters(c), { size: 20, iconSize: 11 }),
      ),
  );

  if (view.search.filtersOpen) {
    section = section.child(
      v_flex()
        .flex_none()
        .mx(8)
        .mb(5)
        .gap(4)
        .child(filterInput(t, view.includeInput, "Files to include, comma separated"))
        .child(filterInput(t, view.excludeInput, "Files to exclude, comma separated")),
    );
  }

  if (view.search.replaceOpen) {
    section = section.child(
      h_flex()
        .flex_none()
        .mx(8)
        .mb(5)
        .gap(5)
        .items_center()
        .child(div().flex_1().min_w(0).child(filterInput(t, view.replaceInput, "Replace with")))
        .child(ghostButton(t, "farrier-files-search-preserve", "AB", (c) => view.toggleSearchPreserve(c), { active: view.search.preserveCase, tooltip: "Preserve case" }))
        .child(
          textButton(t, "farrier-files-search-replace-all", "Replace", (c) => view.askReplaceAll(c), {
            primary: true,
            height: 26,
            disabled: !count,
            tooltip: count ? "Replace every search result" : "No results to replace",
          }),
        ),
    );
  }

  section = section.child(
    h_flex()
      .flex_none()
      .mx(9)
      .mb(4)
      .gap(6)
      .items_center()
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(10.5)
          .text_color(view.searchMeta?.error ? t.blocked : t.dim)
          .child(view.searchMeta?.error || view.searchMeta?.warning || view.searchSummaryText()),
      )
      .when(Boolean(view.searchSelectedFile), (e) =>
        e.child(
          textButton(t, "farrier-files-search-replace-file", "Replace in file", (c) => view.askReplaceFile(c), {
            height: 22,
            px: 7,
            textSize: 10,
            disabled: !count,
          }),
        ),
      )
      .when(Boolean(view.searchSelectedMatch) && view.search.replaceOpen, (e) =>
        e
          .child(
            textButton(t, "farrier-files-search-replace-match", "Replace", (c) => view.replaceSearchMatch(c), {
              height: 22,
              px: 7,
              textSize: 10,
              primary: true,
            }),
          )
          .child(
            ghostButton(t, "farrier-files-search-dismiss-match", "Dismiss", (c) => view.dismissSearchMatch(c), {
              height: 20,
              tooltip: "Remove this result from the list",
            }),
          ),
      ),
  );

  section = section.child(
    v_flex()
      .flex_1()
      .min_h(0)
      .relative()
      .child(
        v_virtual_list(
          SEARCH_ID,
          view.searchRows.length,
          view.searchRows.length ? view.searchRows.map((row) => row.size) : 24,
          (index) => view.searchRows[index]?.key ?? String(index),
          (range) => view.searchRows.slice(range.start, range.end).map((row) => searchRow(view, row, t)),
        )
          .size_full()
          .on_item_click((key, c) => view.activateSearchRow(key, c))
          .track_scroll(view.searchScroll),
      )
      .child(Scrollbar.vertical(SEARCH_ID).absolute().inset_0())
      .when(!view.searchRows.length, (e) =>
        e.child(
          div()
            .absolute()
            .inset_0()
            .p(12)
            .text_size(11)
            .text_color(t.dim)
            .child(view.searchLoading ? "Searching…" : String(view.search.query ?? "").trim() ? "No results" : "Type to search the workspace"),
        ),
      ),
  );

  return section;
}

function searchRow(view, row, t) {
  if (row.kind === "file") {
    const { base, dir } = splitPathInfo(row.file);
    const selected = view.searchSelectedFile === row.file;
    return h_flex()
      .id(`farrier-files-search-file-${row.file}`)
      .w_full()
      .h(28)
      .flex_none()
      .px(6)
      .gap(6)
      .items_center()
      .rounded(5)
      .cursor_pointer()
      .when(selected, (e) => e.bg(t.selected))
      .hover((s) => s.bg(selected ? t.selected : t.hover))
      .child(icon(row.collapsed ? "chevron-right" : "chevron-down", t.dim, 10))
      .child(icon(view.kindFor(row.file).icon, t[view.kindFor(row.file).tone] ?? t.muted, 13))
      .child(div().min_w(0).max_w(150).truncate().text_size(11.5).font_medium().child(base))
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(dir ? `${dir}` : ""))
      .child(countBadge(t, String(row.count)));
  }
  const match = row.match;
  const segments = contextSegments(match.lineText ?? match.text, match.column, match.endColumn ?? match.column + match.length);
  const preview =
    view.search.replaceOpen && String(view.search.replace ?? "")
      ? replacementPreview(view.search.replace, match, { regex: view.search.regex, preserveCase: view.search.preserveCase })
      : "";
  return h_flex()
    .id(`farrier-files-search-match-${row.key}`)
    .w_full()
    .h(24)
    .flex_none()
    .px(6)
    .gap(6)
    .items_center()
    .rounded(4)
    .cursor_pointer()
    .when(view.searchSelectedMatch?.key === row.key, (e) => e.bg(t.selected))
    .hover((s) => s.bg(view.searchSelectedMatch?.key === row.key ? t.selected : t.hover))
    .child(div().w(40).flex_none().text_right().text_size(9.5).text_color(t.dim).child(String(match.line)))
    .child(
      h_flex()
        .flex_1()
        .min_w(0)
        .overflow_hidden()
        .text_size(10.5)
        .text_color(t.muted)
        .children(
          segments.map((segment, index) =>
            div()
              .flex_none()
              .when(segment.hit && Boolean(preview), (e) => e.bg(t.selected).text_color(t.blocked).font_medium().line_through())
              .when(segment.hit && !preview, (e) => e.bg(t.selected).text_color(t.foreground).font_medium())
              .child(segment.text.replace(/\s+/g, " ")),
          ),
        ),
    )
    .when(Boolean(preview), (e) =>
      e.child(
        div()
          .flex_none()
          .max_w(120)
          .truncate()
          .text_size(10)
          .text_color(t.done)
          .child(`→ ${preview.replace(/\s+/g, " ")}`),
      ),
    );
}

function menuItem(t, id, label, onClick, view, options = {}) {
  return h_flex()
    .id(id)
    .h(30)
    .flex_none()
    .mx(4)
    .px(8)
    .gap(8)
    .items_center()
    .rounded(6)
    .cursor_pointer()
    .text_size(11.5)
    .text_color(options.danger ? t.blocked : options.muted ? t.dim : t.foreground)
    .when(options.active, (e) => e.bg(t.hover).text_color(options.danger ? t.blocked : t.foreground))
    .hover((s) => s.bg(options.danger ? t.blocked + "18" : t.hover))
    .on_click((_event, cx) => {
      cx.stop_propagation();
      onClick(cx);
    })
    .when(Boolean(options.icon), (e) => e.child(icon(options.icon, options.danger ? t.blocked : t.muted, 12)))
    .child(div().flex_1().min_w(0).truncate().child(label))
    .when(Boolean(options.hint), (e) => e.child(div().text_size(9.5).text_color(t.dim).child(options.hint)));
}

export function renderContextMenu(view, t, cx) {
  const menu = view.menu;
  const target = view.rows.find((row) => row.path === menu.path) ?? { path: menu.path, name: splitPathInfo(menu.path).base, dir: menu.dir };
  const x = Math.max(8, Math.min(menu.x, (menu.bounds?.width ?? 300) - 228));
  const y = Math.max(8, Math.min(menu.y, (menu.bounds?.height ?? 300) - 190));
  const items = view.menuItems ?? [];
  return div()
    .absolute()
    .inset_0()
    .child(
      div()
        .absolute()
        .inset_0()
        .on_mouse_down("left", (_event, c) => view.closeMenu(c)),
    )
    .child(
      v_flex()
        .id("farrier-files-context-menu")
        .absolute()
        .left(x)
        .top(y)
        .w(220)
        .p(3)
        .gap(1)
        .rounded(9)
        .bg(t.popover)
        .border_1()
        .border_color(t.border)
        .shadow_lg()
        .track_focus(view.menuHandle)
        .key_context("FarrierFilesMenu")
        .on_key_down((event, c) => view.onMenuKey(event, c))
        .on_mouse_down("left", (_event, c) => c.stop_propagation())
        .child(
          h_flex()
            .h(28)
            .flex_none()
            .px(8)
            .gap(6)
            .items_center()
            .child(icon(target.dir ? "folder" : view.kindFor(menu.path).icon, t.muted, 12))
            .child(div().flex_1().min_w(0).truncate().text_size(10).font_semibold().text_color(t.dim).child(target.name)),
        )
        .children(
          items.map((item, index) =>
            menuItem(t, `farrier-files-menu-${item.key}`, item.label, (c) => view.runMenuItem(index, c), view, {
              icon: item.icon,
              danger: item.danger === true,
              active: index === view.menuIndex,
            }),
          ),
        ),
    );
}

function dialogBackdrop(t, view, card) {
  return div()
    .absolute()
    .inset_0()
    .child(
      div()
        .absolute()
        .inset_0()
        .bg(t.canvas + "d9")
        .on_mouse_down("left", (_event, c) => view.closeDialog(c)),
    )
    .child(
      div()
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .child(card),
    );
}

function dialogCard(t, id, children, view) {
  return v_flex()
    .id(id)
    .w(340)
    .p(14)
    .gap(10)
    .rounded(11)
    .bg(t.popover)
    .border_1()
    .border_color(t.border)
    .shadow_lg()
    .on_mouse_down("left", (_event, c) => c.stop_propagation())
    .children(children);
}

export function renderDialog(view, t, cx) {
  const dialog = view.dialog;
  if (!dialog) return null;
  if (dialog.kind === "rename") {
    return dialogBackdrop(
      t,
      view,
      dialogCard(
        t,
        "farrier-files-rename-dialog",
        [
          div().text_size(12.5).font_semibold().text_color(t.foreground).child("Rename"),
          div().text_size(10.5).text_color(t.dim).child(dialog.path),
          filterInput(t, view.renameInput, "New name"),
          h_flex()
            .gap(6)
            .justify_end()
            .child(textButton(t, "farrier-files-rename-cancel", "Cancel", (c) => view.closeDialog(c)))
            .child(
              textButton(t, "farrier-files-rename-confirm", "Rename", (c) => view.confirmRename(c), {
                primary: true,
                disabled: !String(view.renameText ?? "").trim(),
              }),
            ),
        ],
        view,
      ),
    );
  }
  if (dialog.kind === "delete") {
    return dialogBackdrop(
      t,
      view,
      dialogCard(
        t,
        "farrier-files-delete-dialog",
        [
          div().text_size(12.5).font_semibold().text_color(t.foreground).child("Delete?"),
          div()
            .text_size(10.5)
            .text_color(t.dim)
            .child(`${dialog.path}${dialog.dir ? " and everything in it" : ""}.${dialog.dirty ? " An open tab has unsaved edits." : ""} This cannot be undone.`),
          h_flex()
            .gap(6)
            .justify_end()
            .child(textButton(t, "farrier-files-delete-cancel", "Cancel", (c) => view.closeDialog(c)))
            .child(textButton(t, "farrier-files-delete-confirm", "Delete", (c) => view.confirmDelete(c), { danger: true })),
        ],
        view,
      ),
    );
  }
  if (dialog.kind === "replace") {
    return dialogBackdrop(
      t,
      view,
      dialogCard(
        t,
        "farrier-files-replace-dialog",
        [
          div().text_size(12.5).font_semibold().text_color(t.foreground).child("Replace all?"),
          div()
            .text_size(10.5)
            .text_color(t.dim)
            .child(
              `Replace ${dialog.count} occurrence${dialog.count === 1 ? "" : "s"} in ${dialog.files} file${dialog.files === 1 ? "" : "s"}. Files changed since the search, or open with unsaved edits, are skipped.`,
            ),
          h_flex()
            .gap(6)
            .justify_end()
            .child(textButton(t, "farrier-files-replace-cancel", "Cancel", (c) => view.closeDialog(c)))
            .child(textButton(t, "farrier-files-replace-confirm", "Replace", (c) => view.confirmReplaceAll(c), { primary: true })),
        ],
        view,
      ),
    );
  }
  return dialogBackdrop(
    t,
    view,
    dialogCard(
      t,
      "farrier-files-reload-dialog",
      [
        div().text_size(12.5).font_semibold().text_color(t.foreground).child("Reload?"),
        div().text_size(10.5).text_color(t.dim).child("Discard unsaved edits and read the file from disk."),
        h_flex()
          .gap(6)
          .justify_end()
          .child(textButton(t, "farrier-files-reload-cancel", "Cancel", (c) => view.closeDialog(c)))
          .child(textButton(t, "farrier-files-reload-confirm", "Reload", (c) => view.confirmReload(c), { primary: true })),
      ],
      view,
    ),
  );
}
