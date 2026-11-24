// Renders the exclusive file tab: header, editor or preview, and the find
// widget. Row handlers stay outside virtual renderers.

import { div, image } from "gpui-kit";
import { v_flex, h_flex, Input, Textarea, Editor, Scrollbar, v_virtual_list, TextView } from "gpui-base";
import { contextSegments } from "./search-logic.js";
import { formatNumber, splitPathInfo } from "./files-logic.js";
import { icon, toolButton, textButton, ghostButton, countBadge } from "./ui.js";

const FIND_ID = "farrier-files-find-results";
const CSV_ID = "farrier-files-csv";
const CSV_X_ID = "farrier-files-csv-x";

function counterText(view) {
  const find = view.find;
  if (!find.query) return "";
  if (!find.valid) return "Invalid regex";
  if (!find.matches.length) return "No results";
  const current = Math.min(find.matches.length, Math.max(0, find.current)) + 1;
  return `${current} of ${find.matches.length}`;
}

function headerPill(t, text, active = false) {
  return div()
    .flex_none()
    .h(20)
    .px(7)
    .flex()
    .items_center()
    .rounded(5)
    .bg(active ? t.selected : t.raised)
    .text_size(9.5)
    .text_color(active ? t.accent : t.dim)
    .child(text);
}

function viewSwitch(view, t, cx) {
  if (!view.hasPreview()) return div();
  return h_flex()
    .flex_none()
    .h(24)
    .p(2)
    .gap(1)
    .rounded(6)
    .bg(t.raised)
    .child(
      ghostButton(t, "farrier-files-view-preview", "Preview", (c) => view.setViewMode("preview", c), {
        active: view.viewMode === "preview",
        height: 20,
      }),
    )
    .child(
      ghostButton(t, "farrier-files-view-code", "Code", (c) => view.setViewMode("code", c), {
        active: view.viewMode === "code",
        height: 20,
      }),
    );
}

function renderHeader(view, t, cx) {
  const { base, dir } = splitPathInfo(view.file);
  const { label } = view.languageInfo();
  const canEdit = view.canEdit();
  let header = h_flex()
    .id("farrier-files-file-header")
    .h(40)
    .flex_none()
    .px(9)
    .gap(6)
    .items_center()
    .bg(t.chrome)
    .border_b_1()
    .border_color(t.border)
    .child(icon(view.isImage ? "image" : view.kind.icon, t[view.kind.tone] ?? t.muted, 14))
    .child(
      div()
        .flex_none()
        .max_w(220)
        .truncate()
        .text_size(12)
        .font_semibold()
        .text_color(t.foreground)
        .when(view.isPreviewTab(), (e) => e.italic().text_color(t.dim))
        .child(base),
    )
    .when(view.dirty, (e) => e.child(div().flex_none().w(5).h(5).rounded(3).bg(t.accent)))
    .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(dir))
    .child(
      headerPill(
        t,
        view.loading
          ? "Loading"
          : view.isXlsx
            ? view.workbook
              ? `${view.workbook.sheets.length} sheet${view.workbook.sheets.length === 1 ? "" : "s"} · Excel`
              : "Workbook"
            : view.binary
              ? "Binary"
              : view.isImage
                ? "Image"
                : `${formatNumber(view.lineCount)} lines · ${label}`,
      ),
    )
    .child(div().flex_1().min_w(0))
    .child(viewSwitch(view, t, cx));

  if (view.isImage && view.viewMode === "preview") {
    header = header
      .child(toolButton(t, "farrier-files-zoom-out", "minus", t.dim, "Zoom out", (c) => view.zoomBy(-1, c), { size: 20, iconSize: 11 }))
      .child(
        h_flex()
          .id("farrier-files-zoom-reset")
          .flex_none()
          .h(22)
          .px(6)
          .items_center()
          .rounded(5)
          .cursor_pointer()
          .text_size(10)
          .text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Fit to the pane")
          .on_click((_event, c) => view.resetZoom(c))
          .child(`${view.zoom}%`),
      )
      .child(toolButton(t, "farrier-files-zoom-in", "plus", t.dim, "Zoom in", (c) => view.zoomBy(1, c), { size: 20, iconSize: 11 }));
  }

  if (canEdit) {
    header = header.child(
      toolButton(t, "farrier-files-save", "save", view.dirty ? t.accent : t.dim, view.saving ? "Saving…" : "Save (Ctrl+S)", (c) => view.save(c), {
        active: view.dirty,
        size: 22,
      }),
    );
  } else if (view.readonly) {
    header = header.child(toolButton(t, "farrier-files-readonly", "lock", t.dim, view.readonlyReason || "Read only", () => {}, { size: 22 }));
  }

  if (view.canFind()) {
    header = header.child(toolButton(t, "farrier-files-find", "search", view.find.open ? t.accent : t.dim, "Find and replace (Ctrl+F)", (c) => view.openFind(c), { active: view.find.open }));
  }
  if (view.viewMode === "code" && view.code) {
    header = header.child(toolButton(t, "farrier-files-wrap", "wrap", view.wrap ? t.accent : t.dim, view.wrap ? "Soft wrap on" : "Soft wrap off", (c) => view.toggleWrap(c), { active: view.wrap }));
  }
  header = header
    .child(toolButton(t, "farrier-files-copy", "copy", t.dim, "Copy file text", (c) => view.copyText(c)))
    .child(toolButton(t, "farrier-files-open-in-files", "folder-open", t.dim, "Open in folder", (c) => view.openInFileManager(view.file, c)))
    .child(toolButton(t, "farrier-files-split-right", "split-right", t.dim, "Split right", (c) => view.split("right", c)))
    .child(toolButton(t, "farrier-files-split-down", "split-down", t.dim, "Split down", (c) => view.split("down", c)))
    .child(toolButton(t, "farrier-files-refresh", "refresh", t.dim, "Reload from disk", (c) => view.reload(c)));

  return header;
}

export function renderFile(view, t, cx) {
  const body = view.loading
    ? v_flex().flex_1().min_h(0).items_center().justify_center().gap(8).child(div().text_size(12).text_color(t.dim).child("Loading…"))
    : view.fileError
      ? v_flex().flex_1().min_h(0).items_center().justify_center().p(24).child(div().max_w(560).text_size(11.5).text_color(t.dim).child(view.fileError))
      : view.binary && !view.isXlsx
        ? v_flex().flex_1().min_h(0).items_center().justify_center().p(24).child(div().max_w(480).text_size(11.5).text_color(t.dim).child("Binary file · no text preview"))
        : view.isImage && view.viewMode === "preview"
          ? renderImageView(view, t, cx)
          : view.isXlsx
            ? view.workbook
              ? renderSpreadsheetView(view, t, cx)
              : v_flex().flex_1().min_h(0).items_center().justify_center().p(24).child(div().max_w(520).text_size(11.5).text_color(t.dim).child("Workbook preview is not available in this panel."))
            : view.viewMode === "preview" && view.isMarkdown
              ? renderMarkdownView(view, t)
              : view.viewMode === "preview" && view.isSvg
                ? renderImageView(view, t, cx)
                : view.viewMode === "preview" && view.isCsv
                  ? renderSpreadsheetView(view, t, cx)
                  : renderCodeView(view, t, cx);

  let root = v_flex()
    .id("farrier-files-file")
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
    .key_context("FarrierFilesEditor")
    .on_key_down((event, c) => view.onFileKey(event, c))
    .on_key_up((event, c) => view.onFileKeyUp(event, c))
    .child(renderHeader(view, t, cx));

  if (view.fileError && !view.loading) {
    root = root.child(
      h_flex()
        .mx(8)
        .mt(6)
        .p(6)
        .gap(6)
        .rounded(6)
        .bg(t.blocked + "18")
        .border_1()
        .border_color(t.blocked + "55")
        .child(icon("close", t.blocked, 11))
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.blocked).child(view.fileError)),
    );
  }

  if (view.truncated) {
    root = root.child(
      h_flex()
        .mx(8)
        .mt(6)
        .p(6)
        .gap(6)
        .rounded(6)
        .bg(t.raised)
        .border_1()
        .border_color(t.border)
        .child(icon("lock", t.dim, 11))
        .child(div().flex_1().min_w(0).text_size(10.5).text_color(t.dim).child("Preview truncated at 1 MiB; the file is read-only here.")),
    );
  }
  root = root.child(body);
  if (view.find.open) root = root.child(renderFindPanel(view, t, cx));
  if (view.dialog) root = root.child(renderFileDialog(view, t, cx));
  return root;
}

export function renderCodeView(view, t, cx) {
  if (!view.code) {
    return v_flex().flex_1().min_h(0).items_center().justify_center().child(div().text_size(11.5).text_color(t.dim).child("No text view"));
  }
  return v_flex()
    .flex_1()
    .min_h(0)
    .relative()
    .bg(t.surface)
    .child(Editor.new(view.code).size_full());
}

export function renderMarkdownView(view, t) {
  return v_flex()
    .flex_1()
    .min_h(0)
    .items_center()
    .overflow_y_scrollbar()
    .p(20)
    .child(
      div()
        .w_full()
        .max_w(860)
        .child(TextView.markdown(view.markdownId, view.text).scrollable(false).selectable(true)),
    );
}

export function renderImageView(view, t, cx) {
  const pad = 24;
  const width = view.viewport?.width ?? 0;
  const height = view.viewport?.height ?? 0;
  const size = view.imageSize;
  let shown = null;
  if (size && width > 0 && height > 0) {
    const fit = Math.min((width - pad * 2) / size.width, (height - pad * 2) / size.height);
    const scale = Math.max(0.02, fit) * (view.zoom / 100);
    shown = { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
  }
  return v_flex()
    .id("farrier-files-image")
    .flex_1()
    .min_h(0)
    .relative()
    .bg(view.isSvg ? t.ansi15 : t.canvas)
    .overflow_scrollbar()
    .on_size_change((next, c) => view.setViewport(next, c))
    .on_scroll_wheel((event, c) => {
      if (event.modifiers.control || event.modifiers.platform) {
        view.zoomBy(event.delta?.y > 0 ? -1 : 1, c);
        c.stop_propagation();
      }
    })
    .child(
      v_flex()
        .min_w_full()
        .min_h_full()
        .items_center()
        .justify_center()
        .p(pad)
        .when(Boolean(view.imageSrc), (e) =>
          e.child(
            shown
              ? image(view.imageSrc).w(shown.width).h(shown.height)
              : image(view.imageSrc).max_w_full().max_h_full(),
          ),
        )
        .when(!view.imageSrc, (e) =>
          e.child(
            div()
              .text_size(11.5)
              .text_color(view.isSvg ? t.muted : t.dim)
              .child(view.imageLoading ? "Loading…" : "No picture"),
          ),
        ),
    );
}

function csvCell(t, text, index, headerRow, width = 140) {
  return div()
    .flex_none()
    .w(index === 0 ? 42 : width)
    .h_full()
    .flex()
    .items_center()
    .px(index === 0 ? 0 : 8)
    .when(index === 0, (e) => e.justify_end().pr(7))
    .when(headerRow, (e) => e.bg(t.raised).font_semibold().text_color(t.foreground))
    .when(index === 0, (e) => e.text_size(9.5).text_color(t.dim))
    .when(index > 0, (e) => e.text_size(11).text_color(t.muted))
    .truncate()
    .child(String(text ?? ""));
}

function csvHeader(view, t, data) {
  const shownColumns = Math.min(40, data?.columns ?? 0);
  let row = h_flex()
    .id("farrier-files-csv-header")
    .w(42 + shownColumns * 140)
    .h(26)
    .flex_none()
    .items_center()
    .border_b_1()
    .border_color(t.border);
  row = row.child(
    div()
      .flex_none()
      .w(42)
      .h_full()
      .flex()
      .items_center()
      .justify_end()
      .pr(7)
      .bg(t.raised)
      .text_size(9.5)
      .text_color(t.dim)
      .child("#"),
  );
  for (let i = 0; i < shownColumns; i += 1) row = row.child(csvCell(t, `#${i + 1}`, i + 1, true));
  return row;
}

function csvRow(view, t, index, data) {
  const shownColumns = Math.min(40, data?.columns ?? 0);
  const cells = data?.rows?.[index] ?? [];
  let row = h_flex()
    .id(`farrier-files-csv-row-${index}`)
    .w(42 + shownColumns * 140)
    .h(24)
    .flex_none()
    .items_center()
    .border_b_1()
    .border_color(t.border)
    .when(index % 2 === 1, (e) => e.bg(t.surface));
  row = row.child(
    div()
      .flex_none()
      .w(42)
      .h_full()
      .flex()
      .items_center()
      .justify_end()
      .pr(7)
      .bg(t.chrome)
      .text_size(9.5)
      .text_color(t.dim)
      .child(String(index + 1)),
  );
  for (let i = 0; i < shownColumns; i += 1) row = row.child(csvCell(t, cells[i], i + 1, false));
  return row;
}

function sheetTab(view, t, name, index, cx) {
  const active = view.activeSheet === index;
  return h_flex()
    .id(`farrier-files-sheet-${index}`)
    .flex_none()
    .h(24)
    .px(8)
    .gap(5)
    .items_center()
    .rounded(5)
    .cursor_pointer()
    .text_size(10.5)
    .text_color(active ? t.foreground : t.muted)
    .when(active, (e) => e.bg(t.selected).font_medium())
    .hover((s) => s.bg(active ? t.selected : t.hover).text_color(t.foreground))
    .on_click((_event, c) => view.switchSheet(index, c))
    .child(div().max_w(120).truncate().child(name));
}

export function renderSpreadsheetView(view, t, cx) {
  const sheet = view.tableData();
  if (!sheet) return v_flex().flex_1().min_h(0).items_center().justify_center().child(div().text_size(11.5).text_color(t.dim).child("No table"));
  const shownColumns = Math.min(40, sheet.columns);
  const tableWidth = 42 + shownColumns * 140;
  let root = v_flex().flex_1().min_h(0);
  if (view.isXlsx && view.workbook?.sheets?.length > 1) {
    root = root.child(
      h_flex()
        .flex_none()
        .h(30)
        .mx(8)
        .mb(3)
        .gap(2)
        .items_center()
        .overflow_x_scrollbar()
        .children(view.workbook.sheets.map((item, index) => sheetTab(view, t, item.name, index, cx))),
    );
  }
  root = root.child(
    v_flex()
      .flex_1()
      .min_h(0)
      .relative()
      .child(
        div()
          .id(CSV_X_ID)
          .size_full()
          .overflow_x_scroll()
          .child(
            v_flex()
              .w(tableWidth)
              .h_full()
              .child(csvHeader(view, t, sheet))
              .child(
                v_virtual_list(
                  CSV_ID,
                  sheet.rows.length,
                  24,
                  (index) => `csv-${index}`,
                  (range) => {
                    const out = [];
                    for (let i = range.start; i < range.end; i += 1) out.push(csvRow(view, t, i, sheet));
                    return out;
                  },
                )
                  .w(tableWidth)
                  .flex_1(),
              ),
          ),
      )
      .child(Scrollbar.vertical(CSV_ID).absolute().right(0).top(26).bottom(0).w(6))
      .child(Scrollbar.horizontal(CSV_X_ID).absolute().left(0).right(0).bottom(0).h(6))
      .when(sheet.truncated || sheet.columns > shownColumns, (e) =>
        e.child(
          div()
            .absolute()
            .left(8)
            .bottom(5)
            .px(6)
            .h(18)
            .flex()
            .items_center()
            .rounded(4)
            .bg(t.popover)
            .text_size(9.5)
            .text_color(t.dim)
            .child(`Preview limited to ${formatNumber(sheet.rows.length)} rows and ${shownColumns} columns`),
        ),
      )
      .when(view.isXlsx && view.workbook?.truncated, (e) =>
        e.child(
          div()
            .absolute()
            .right(8)
            .bottom(5)
            .px(6)
            .h(18)
            .flex()
            .items_center()
            .rounded(4)
            .bg(t.popover)
            .text_size(9.5)
            .text_color(t.dim)
            .child("Only the first 6 sheets are shown"),
        ),
      ),
  );
  return root;
}

export function renderFindPanel(view, t, cx) {
  let panel = v_flex()
    .id("farrier-files-find")
    .absolute()
    .top(46)
    .right(6)
    .w(348)
    .p(7)
    .gap(5)
    .rounded(9)
    .bg(t.popover)
    .border_1()
    .border_color(t.border)
    .shadow_lg()
    .on_mouse_down("left", (_event, c) => c.stop_propagation())
    .child(
      h_flex()
        .gap(4)
        .items_center()
        .child(
          toolButton(t, "farrier-files-find-replace-toggle", view.find.replaceOpen ? "chevron-down" : "chevron-right", t.dim, "Replace row", (c) => view.toggleFindReplace(c), { size: 20, iconSize: 10 }),
        )
        .child(div().flex_1().min_w(0).child(filterField(t, view.findInput, "Find", null, false, true)),
        )
        .child(div().flex_none().max_w(92).truncate().text_size(10).text_color(view.find.valid ? t.dim : t.blocked).child(counterText(view)))
        .child(toolButton(t, "farrier-files-find-prev", "arrow-up", t.dim, "Previous match (Ctrl+Shift+Enter)", (c) => view.stepFind(-1, c), { size: 20, iconSize: 11 }))
        .child(toolButton(t, "farrier-files-find-next", "arrow-down", t.dim, "Next match (Ctrl+Enter)", (c) => view.stepFind(1, c), { size: 20, iconSize: 11 }))
        .child(toolButton(t, "farrier-files-find-close", "close", t.dim, "Close find (Esc)", (c) => view.closeFind(c), { size: 20, iconSize: 10 }),
        ),
    )
    .child(
      h_flex()
        .gap(4)
        .items_center()
        .child(ghostButton(t, "farrier-files-find-case", "Aa", (c) => view.toggleFindOption("caseSensitive", c), { active: view.find.caseSensitive, tooltip: "Match case" }))
        .child(ghostButton(t, "farrier-files-find-word", "ab", (c) => view.toggleFindOption("wholeWord", c), { active: view.find.wholeWord, tooltip: "Whole word" }))
        .child(ghostButton(t, "farrier-files-find-regex", ".*", (c) => view.toggleFindOption("regex", c), { active: view.find.regex, tooltip: "Regular expression" }))
        .child(div().flex_1())
        .child(countBadge(t, `${findMatchesLabel(view)}`)),
    );

  if (view.find.replaceOpen) {
    panel = panel.child(
      h_flex()
        .gap(4)
        .items_center()
        .child(div().flex_1().min_w(0).child(filterField(t, view.findReplaceInput, "Replace with", null, true)))
        .child(ghostButton(t, "farrier-files-find-preserve", "AB", (c) => view.toggleFindPreserve(c), { active: view.find.preserveCase, tooltip: "Preserve case" }))
        .child(textButton(t, "farrier-files-find-replace-one", "Replace", (c) => view.replaceCurrent(c), { height: 24, px: 7, textSize: 10, disabled: !view.canEdit() || !view.find.matches.length }))
        .child(textButton(t, "farrier-files-find-replace-all", "All", (c) => view.replaceAllInFile(c), { height: 24, px: 7, textSize: 10, primary: true, disabled: !view.canEdit() || !view.find.matches.length })),
    );
  }

  if (view.find.matches.length) {
    panel = panel.child(
      v_flex()
        .relative()
        .h(168)
        .min_h(80)
        .rounded(7)
        .bg(t.input)
        .border_1()
        .border_color(t.border)
        .child(
          v_virtual_list(
            FIND_ID,
            view.find.matches.length,
            22,
            (index) => String(index),
            (range) =>
              view.find.matches.slice(range.start, range.end).map((match, offset) => findRow(view, match, range.start + offset, t)),
          )
            .size_full()
            .on_item_click((key, c) => view.selectFindIndex(Number(key), c)),
        )
        .child(Scrollbar.vertical(FIND_ID).absolute().inset_0()),
    );
  }
  return panel;
}

function filterField(t, state, placeholder, width = null, replace = false, multiline = false) {
  let row = h_flex()
    .min_h(26)
    .flex_none()
    .px(7)
    .gap(6)
    .items_center()
    .rounded(6)
    .bg(t.input)
    .border_1()
    .border_color(t.border)
    .when(!multiline, (e) => e.h(26))
    .child(icon(replace ? "wrap" : "search", t.dim, 11))
    .child(
      div()
        .flex_1()
        .min_w(0)
        .child(
          multiline
            ? Textarea.new(state).w_full().text_size(11.5).text_color(t.foreground)
            : Input.new(state).size_full().text_size(11.5).text_color(t.foreground),
        ),
    );
  if (width) row = row.w(width);
  return row;
}

function findMatchesLabel(view) {
  const count = view.find.matches.length;
  return count ? `${formatNumber(count)} match${count === 1 ? "" : "es"}` : "0";
}

function findRow(view, match, index, t) {
  const active = index === view.find.current;
  const text = view.findLineText(match);
  const segments = contextSegments(text, match.column, match.endColumn, 100);
  return h_flex()
    .id(`farrier-files-find-row-${index}`)
    .w_full()
    .h(22)
    .flex_none()
    .px(5)
    .gap(6)
    .items_center()
    .rounded(4)
    .when(active, (e) => e.bg(t.selected))
    .hover((s) => s.bg(active ? t.selected : t.hover))
    .child(div().w(30).flex_none().text_right().text_size(9).text_color(t.dim).child(String(match.line)))
    .child(
      h_flex()
        .flex_1()
        .min_w(0)
        .overflow_hidden()
        .text_size(10.5)
        .text_color(t.muted)
        .children(
          segments.map((segment) =>
            div()
              .flex_none()
              .when(segment.hit, (e) => e.bg(t.selected).text_color(t.foreground).font_medium())
              .child(segment.text.replace(/\s+/g, " ")),
          ),
        ),
    )
    .when(Number(match.lineSpan) > 1, (e) =>
      e.child(div().flex_none().text_size(9).text_color(t.dim).child(`${match.lineSpan}L`)),
    );
}

function renderFileDialog(view, t, cx) {
  const dialog = view.dialog;
  if (!dialog) return null;
  const conflict = dialog.kind === "save-conflict";
  const title = conflict ? "File changed on disk" : dialog.kind === "reload" ? "Reload?" : "Discard edits?";
  const body = conflict
    ? `${splitPathInfo(view.file).base} changed outside Herdr. Your draft is still here. Overwrite the newer file, reload it, or keep editing.`
    : "Discard unsaved edits and read the file from disk.";
  let actions = h_flex()
    .gap(6)
    .justify_end()
    .child(textButton(t, "farrier-files-file-dialog-cancel", "Cancel", (c) => view.closeDialog(c)))
    .child(
      textButton(t, "farrier-files-file-dialog-confirm", "Reload", (c) => view.confirmReload(c), {
        danger: conflict,
        primary: !conflict,
      }),
    );
  if (conflict) {
    actions = actions.child(
      textButton(t, "farrier-files-file-dialog-overwrite", "Overwrite", (c) => view.confirmSaveConflict(c), { primary: true }),
    );
  }
  const card = v_flex()
    .id("farrier-files-file-dialog")
    .w(conflict ? 390 : 330)
    .p(14)
    .gap(10)
    .rounded(11)
    .bg(t.popover)
    .border_1()
    .border_color(t.border)
    .shadow_lg()
    .on_mouse_down("left", (_event, c) => c.stop_propagation())
    .child(div().text_size(12.5).font_semibold().child(title))
    .child(div().text_size(10.5).text_color(t.dim).child(body))
    .child(actions);
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
    .child(div().absolute().inset_0().flex().items_center().justify_center().child(card));
}
