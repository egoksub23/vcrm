import type { SuggestionOptions } from "@tiptap/suggestion";

/** A person who can be @mentioned — matches Mention's own node attrs shape
 *  ({id, label}), so `props.command(candidate)` inserts it directly. */
export interface MentionCandidate {
  id: string;
  label: string;
}

/** A plain positioned list — no tippy.js — matching the keyboard-nav bar
 *  `MentionTextarea` already set (arrow keys, Enter/Tab to pick, click to
 *  pick, Escape to close). Positioning is handled by Tiptap's own
 *  `props.mount()` (Floating UI under the hood — tracks scroll/resize). */
export function createMentionSuggestion(
  getCandidates: () => MentionCandidate[],
): Omit<SuggestionOptions<MentionCandidate>, "editor"> {
  return {
    char: "@",
    items: ({ query }) => {
      const q = query.toLowerCase();
      return getCandidates()
        .filter((c) => c.label.toLowerCase().includes(q))
        .slice(0, 8);
    },
    render: () => {
      let root: HTMLDivElement | null = null;
      let unmount: (() => void) | null = null;
      let items: MentionCandidate[] = [];
      let selectedIndex = 0;
      let command: ((item: MentionCandidate) => void) | null = null;

      const renderList = () => {
        if (!root) return;
        root.innerHTML = "";
        if (items.length === 0) {
          const empty = document.createElement("p");
          empty.className = "px-2.5 py-1.5 text-sm text-muted-foreground";
          empty.textContent = "No match";
          root.appendChild(empty);
          return;
        }
        items.forEach((item, index) => {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = item.label;
          button.className =
            "block w-full rounded-md px-2.5 py-1.5 text-left text-sm " +
            (index === selectedIndex
              ? "bg-primary/15 text-primary"
              : "text-popover-foreground hover:bg-muted");
          button.addEventListener("mousedown", (e) => {
            e.preventDefault();
            command?.(item);
          });
          root!.appendChild(button);
        });
      };

      return {
        onStart: (props) => {
          items = props.items;
          selectedIndex = 0;
          command = props.command;
          root = document.createElement("div");
          root.className =
            "z-50 max-h-56 w-56 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg";
          renderList();
          unmount = props.mount(root);
        },
        onUpdate: (props) => {
          items = props.items;
          command = props.command;
          selectedIndex = Math.min(selectedIndex, Math.max(items.length - 1, 0));
          renderList();
        },
        onKeyDown: (props) => {
          if (!items.length) return false;
          if (props.event.key === "ArrowDown") {
            selectedIndex = (selectedIndex + 1) % items.length;
            renderList();
            return true;
          }
          if (props.event.key === "ArrowUp") {
            selectedIndex = (selectedIndex - 1 + items.length) % items.length;
            renderList();
            return true;
          }
          if (props.event.key === "Enter" || props.event.key === "Tab") {
            command?.(items[selectedIndex]);
            return true;
          }
          if (props.event.key === "Escape") {
            unmount?.();
            unmount = null;
            root = null;
            return true;
          }
          return false;
        },
        onExit: () => {
          unmount?.();
          unmount = null;
          root = null;
        },
      };
    },
  };
}
