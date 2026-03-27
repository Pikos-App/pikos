import { forwardRef, type RefCallback } from "react";

import { cn } from "@/lib/utils";

interface SidebarListItemProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "prefix"> {
  isActive: boolean;
  isRenaming: boolean;
  /** Default value for the inline rename input. */
  label: string;
  onSelect: () => void;
  onRenameStart: () => void;
  onRenameCommit: (value: string) => void;
  onRenameCancel: () => void;
  /** inputRef from useInlineRename — attached to the rename input. */
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Extra flex layout classes, e.g. "items-center gap-2" or "flex-col gap-0.5". */
  className?: string;
  /** Highlights the item as a valid drop target for a dragged page. */
  isDragOver?: boolean;
  // DnD — all optional; omit for non-draggable items
  dragRef?: RefCallback<HTMLDivElement>;
  dragStyle?: React.CSSProperties;
  /** Merged dnd-kit attributes + listeners ({ ...attributes, ...listeners }). */
  dragProps?: Record<string, unknown>;
  /** Always rendered before children/input (e.g. an icon that stays visible during rename). */
  prefix?: React.ReactNode;
  /** Rendered when not renaming. */
  children: React.ReactNode;
}

export const SidebarListItem = forwardRef<HTMLDivElement, SidebarListItemProps>(
  function SidebarListItem(
    {
      children,
      className,
      dragProps,
      dragRef,
      dragStyle,
      inputRef,
      isActive,
      isDragOver = false,
      isRenaming,
      label,
      onRenameCancel,
      onRenameCommit,
      onRenameStart,
      onSelect,
      prefix,
      tabIndex,
      ...rest
    }: SidebarListItemProps,
    ref
  ) {
    function commit() {
      const trimmed = inputRef.current?.value.trim() ?? "";
      if (trimmed) onRenameCommit(trimmed);
      else onRenameCancel();
    }

    return (
      <div
        ref={(node) => {
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
          if (dragRef) dragRef(node as HTMLDivElement);
        }}
        style={dragStyle}
        {...rest}
        {...(dragProps as React.HTMLAttributes<HTMLDivElement>)}
        className={cn(
          "flex cursor-pointer rounded px-2 py-2.5 text-sm outline-none select-none",
          isDragOver
            ? "bg-primary/10 text-foreground ring-1 ring-primary/40"
            : isActive
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          className
        )}
        onClick={isRenaming ? undefined : onSelect}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onRenameStart();
        }}
        tabIndex={tabIndex ?? 0}
      >
        {prefix}
        <div className="relative min-w-0 flex-1">
          <div className={cn("flex min-w-0", isRenaming && "invisible")}>{children}</div>
          {isRenaming && (
            <input
              autoComplete="off"
              className="absolute inset-0 w-full border-0 bg-transparent p-0 text-sm leading-snug text-foreground outline-none"
              defaultValue={label}
              onBlur={commit}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onRenameCancel();
                }
              }}
              ref={inputRef}
            />
          )}
        </div>
      </div>
    );
  }
);
