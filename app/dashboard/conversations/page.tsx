"use client";

/**
 * The right-hand pane before a chat is picked. Only visible in the two-pane
 * layout (1100px+); on a phone the list itself is the whole page.
 */

import { MessagesSquare } from "lucide-react";

export default function NoThreadSelected() {
  return (
    <div className="inbox-placeholder">
      <MessagesSquare aria-hidden />
      <strong>Pick a chat</strong>
      <span>See exactly what the assistant said, which model answered, and what each reply cost.</span>
    </div>
  );
}
