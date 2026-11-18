// Farrier's bottom strip.
//
// The machine, the space you are in, its branch, and how many agents wait on
// you, work, or finished while you looked elsewhere. Click a count to go to an
// agent in that state. `farrier.next` (see keys.pack.json) goes to the next one
// that needs you, then to working or done ones.

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, keys, window, nextCommand } from "herdr";

const LABEL = { blocked: "needs you", working: "working", done: "done" };
const COLOR = { blocked: "blocked", working: "working", done: "done" };

// The key as actually bound in keys.json, not a hardcoded one: a rebinding
// shows up here, and no binding means no hint at all.
function keyHint(action) {
  const bound = keys().find((k) => k.action === action);
  if (!bound) return "";
  const mac = window()?.platform === "macos";
  const glyph = { cmd: "⌘", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Alt+", alt: mac ? "⌥" : "Alt+" };
  return bound.keys.split("-").map((part) => glyph[part.toLowerCase()] ?? part.toUpperCase()).join("");
}

export default class Farrier extends View {
  init() {
    this.watching = false;
    this.at = -1;
  }

  watch(cx) {
    if (this.watching) return;
    this.watching = true;
    cx.spawn(async (cx) => {
      for (;;) {
        if ((await nextCommand()) === "farrier.next") this.next();
        cx.notify();
      }
    });
  }

  next() {
    const list = agents();
    const waiting = list.filter((a) => a.status === "blocked");
    const pool = waiting.length ? waiting : list.filter((a) => a.status === "working" || a.status === "done");
    if (!pool.length) return;
    this.at = (this.at + 1) % pool.length;
    run("agent.focus", { terminal: pool[this.at].address });
  }

  go(status) {
    const agent = agents().find((a) => a.status === status);
    if (agent) run("agent.focus", { terminal: agent.address });
  }

  group(t, status, count) {
    const color = t[COLOR[status]];
    return div()
      .id(`farrier-${status}`)
      .px(6)
      .h(18)
      .flex()
      .items_center()
      .gap(5)
      .rounded(5)
      .text_size(11)
      .text_color(count ? color : t.dim)
      .when(count > 0, (el) => el.bg(color + "22").hover((s) => s.bg(t.hover)))
      .when(count > 0, (el) => el.on_click(() => this.go(status)))
      .child(div().size(6).rounded(3).bg(count ? color : t.border))
      .child(`${count} ${LABEL[status]}`);
  }

  render(cx) {
    this.watch(cx);
    const t = theme();
    const space = spaces().find((s) => s.active);
    const list = agents();
    const n = (status) => list.filter((a) => a.status === status).length;
    const hint = keyHint("farrier.next");
    return h_flex()
      .id("farrier-strip")
      .size_full()
      .px(12)
      .gap(10)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11)
      .text_color(t.muted)
      .child(div().flex_none().truncate().max_w(140).text_color(t.foreground).child(space?.machine ?? "This computer"))
      .when(Boolean(space), (el) => el.child(div().flex_none().truncate().max_w(180).child(space?.name ?? "")))
      .when(Boolean(space?.branch), (el) => el.child(div().flex_none().truncate().max_w(160).text_color(t.dim).child(space?.branch ?? "")))
      .child(div().flex_1())
      .when(list.length === 0, (el) => el.child(div().text_color(t.dim).child("no agents")))
      .when(n("blocked") > 0, (el) => el.child(this.group(t, "blocked", n("blocked"))))
      .when(n("working") > 0, (el) => el.child(this.group(t, "working", n("working"))))
      .when(n("done") > 0, (el) => el.child(this.group(t, "done", n("done"))))
      .when(hint !== "", (el) => el.child(div().text_color(t.dim).child(`${hint} next`)));
  }
}
