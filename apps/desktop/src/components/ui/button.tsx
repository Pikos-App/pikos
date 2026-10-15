import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-[calc(0.5rem*var(--ui-text-scale,1))] rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      // Every box and inset is a calc against the interface text scale, because a
      // plain `h-9` resolves against the root font size, which that setting never
      // touches. Left fixed, a button keeps its 13px-base height and padding while
      // its label and icon double, and the label runs into the edge. At scale 1
      // each value below is identical to the Tailwind class it replaces.
      size: {
        default:
          "h-[calc(2.25rem*var(--ui-text-scale,1))] px-[calc(1rem*var(--ui-text-scale,1))] py-[calc(0.5rem*var(--ui-text-scale,1))] has-[>svg]:px-[calc(0.75rem*var(--ui-text-scale,1))]",
        icon: "size-[calc(2.25rem*var(--ui-text-scale,1))]",
        "icon-lg": "size-[calc(2.5rem*var(--ui-text-scale,1))]",
        "icon-sm": "size-[calc(2rem*var(--ui-text-scale,1))]",
        "icon-xs":
          "size-[calc(1.5rem*var(--ui-text-scale,1))] rounded-md [&_svg:not([class*='size-'])]:size-3",
        lg: "h-[calc(2.5rem*var(--ui-text-scale,1))] rounded-md px-[calc(1.5rem*var(--ui-text-scale,1))] has-[>svg]:px-[calc(1rem*var(--ui-text-scale,1))]",
        sm: "h-[calc(2rem*var(--ui-text-scale,1))] gap-[calc(0.375rem*var(--ui-text-scale,1))] rounded-md px-[calc(0.75rem*var(--ui-text-scale,1))] has-[>svg]:px-[calc(0.625rem*var(--ui-text-scale,1))]",
        xs: "h-[calc(1.5rem*var(--ui-text-scale,1))] gap-[calc(0.25rem*var(--ui-text-scale,1))] rounded-md px-[calc(0.5rem*var(--ui-text-scale,1))] text-xs has-[>svg]:px-[calc(0.375rem*var(--ui-text-scale,1))] [&_svg:not([class*='size-'])]:size-3",
      },
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
      },
    },
  }
);

function Button({
  asChild = false,
  className,
  size = "default",
  variant = "default",
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      className={cn(buttonVariants({ className, size, variant }))}
      data-size={size}
      data-slot="button"
      data-variant={variant}
      {...props}
    />
  );
}

export { Button, buttonVariants };
