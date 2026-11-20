// Shared, handler-free presentation helpers for farrier-files. Rendering
// helpers that register handlers live in the view modules, outside virtual
// list renderers.

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";

export function icon(name, color, size = 14) {
  return svg(`mods/farrier-files/icons/${name}.svg`).size(size).flex_none().text_color(color);
}

export function toolButton(t, id, name, color, tooltip, onClick, options = {}) {
  const size = options.size ?? 22;
  const active = options.active === true;
  let el = h_flex()
    .id(id)
    .flex_none()
    .w(size)
    .h(size)
    .items_center()
    .justify_center()
    .rounded(5)
    .cursor_pointer()
    .text_color(active ? t.accent : color ?? t.dim)
    .when(active, (e) => e.bg(t.selected))
    .hover((s) => s.bg(active ? t.selected : t.hover).text_color(active ? t.accent : t.foreground))
    .when(Boolean(tooltip), (e) => e.tooltip(tooltip))
    .on_click((_event, cx) => {
      cx.stop_propagation();
      onClick(cx);
    });
  if (options.disabled) el = el.disabled(true).opacity(0.42).cursor_pointer();
  if (name) el = el.child(icon(name, active ? t.accent : color ?? t.dim, options.iconSize ?? 13));
  if (options.label) {
    el = el.w("auto").px(7).child(
      div().text_size(11).font_medium().child(options.label),
    );
  }
  return el;
}

export function textButton(t, id, label, onClick, options = {}) {
  let el = h_flex()
    .id(id)
    .flex_none()
    .h(options.height ?? 26)
    .px(options.px ?? 9)
    .gap(5)
    .items_center()
    .justify_center()
    .rounded(6)
    .text_size(options.textSize ?? 11.5)
    .font_medium()
    .text_color(options.danger ? t.blocked : options.primary ? t.accent : t.muted)
    .when(options.primary, (e) => e.bg(t.selected).border_1().border_color(t.accent + "55"))
    .when(!options.primary && !options.danger, (e) => e.bg(t.raised).border_1().border_color(t.border))
    .when(options.danger, (e) => e.bg(t.raised).border_1().border_color(t.blocked + "55"))
    .cursor_pointer()
    .hover((s) => s.bg(t.hover).text_color(options.danger ? t.blocked : options.primary ? t.accent : t.foreground))
    .when(Boolean(options.tooltip), (e) => e.tooltip(options.tooltip))
    .on_click((_event, cx) => {
      cx.stop_propagation();
      onClick(cx);
    });
  if (options.disabled) el = el.disabled(true).opacity(0.42);
  if (options.icon) el = el.child(icon(options.icon, options.danger ? t.blocked : t.muted, 12));
  return el.child(label);
}

export function ghostButton(t, id, label, onClick, options = {}) {
  return h_flex()
    .id(id)
    .flex_none()
    .h(24)
    .px(6)
    .gap(4)
    .items_center()
    .rounded(5)
    .cursor_pointer()
    .text_size(10.5)
    .text_color(options.active ? t.accent : t.dim)
    .when(options.active, (e) => e.bg(t.selected))
    .hover((s) => s.bg(options.active ? t.selected : t.hover).text_color(options.active ? t.accent : t.foreground))
    .when(Boolean(options.tooltip), (e) => e.tooltip(options.tooltip))
    .on_click((_event, cx) => {
      cx.stop_propagation();
      onClick(cx);
    })
    .when(Boolean(options.icon), (e) => e.child(icon(options.icon, options.active ? t.accent : t.muted, 11)))
    .child(label);
}

export function countBadge(t, text) {
  return div()
    .flex_none()
    .px(5)
    .h(16)
    .flex()
    .items_center()
    .rounded(4)
    .bg(t.raised)
    .text_size(9.5)
    .text_color(t.dim)
    .child(text);
}

export function sectionHeader(t, id, label, open, onToggle, trailing = null) {
  let header = h_flex()
    .id(id)
    .h(32)
    .flex_none()
    .px(8)
    .gap(6)
    .items_center()
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click((_event, cx) => onToggle(cx));
  header = header
    .child(icon(open ? "chevron-down" : "chevron-right", t.dim, 11))
    .child(div().flex_1().min_w(0).truncate().text_size(10).font_semibold().text_color(t.dim).child(label));
  if (trailing) header = header.child(trailing);
  return header;
}

export function emptyNote(t, text, options = {}) {
  return div()
    .w_full()
    .p(options.p ?? 12)
    .text_size(options.textSize ?? 11.5)
    .text_color(t.dim)
    .when(options.center, (e) => e.text_center())
    .child(text);
}
