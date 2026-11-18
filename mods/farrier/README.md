# Farrier

A Herdr layout, one mod and its theme.

The `farrier` mod draws the bottom strip: the machine, the space you are in, its
branch, and how many agents wait on you, work, or finished while you looked
elsewhere. Click a count to go to an agent in that state.

`farrier.next` (bound in the layout's key section) goes to the next agent that
needs you, then to a working or done one.

```
Ctrl+Shift+A      next agent that needs you      layout:farrier
```

The strip uses theme colors only, so it follows the Farrier theme, any other
theme, and light or dark. Its type is HarmonyOS Sans SC, bundled under the
HarmonyOS Sans license in `fonts/`.
