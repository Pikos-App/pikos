import type { Folder } from "@pikos/core";
import { currentPaletteColor, PALETTE_COLORS } from "@pikos/core";
import { Check, Palette } from "lucide-react";

import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";

interface FolderColorSubmenuProps {
  current: Folder["color"];
  onColorChange: (color: string) => void;
}

export function FolderColorSubmenu({ current, onColorChange }: FolderColorSubmenuProps) {
  const currentColor = currentPaletteColor(current)?.toUpperCase();

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger className="gap-2">
        <Palette aria-hidden />
        Color
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {PALETTE_COLORS.map(({ label, value }) => {
          const isCurrent = currentColor === value.toUpperCase();

          return (
            <ContextMenuItem
              aria-checked={isCurrent}
              key={value}
              onSelect={() => onColorChange(value)}
              role="menuitemradio"
            >
              <span
                className="color-dot h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: value }}
              />
              {label}
              {isCurrent && <Check aria-hidden className="ml-auto" size={12} />}
            </ContextMenuItem>
          );
        })}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
