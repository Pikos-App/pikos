<script lang="ts">
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import { Button } from "$lib/components/ui/button";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import EllipsisVertical from "@lucide/svelte/icons/ellipsis-vertical";

  export let options: { label: string; value: string; onClick?: () => void }[] = [];
  export let triggerLabel: string | null;
  export let variant: "default" | "outline" | "ghost" | "link" | "destructive" | "secondary" = "outline";
  export let size: "default" | "sm" | "lg" | "icon" = "default";
  export let align: "start" | "center" | "end" = "start";
  export let sideOffset = 8;
  export let alignOffset = 0;
  export let icon: ConstructorOfATypedSvelteComponent | null = null;

  function executeAction(option: { label: string; value: string; onClick?: () => void }) {
    if (option.onClick) {
      option.onClick();
    }
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#if !triggerLabel}
      <Button variant="ghost" size="icon" class="h-8 w-8 p-0">
        <svelte:component this={icon || EllipsisVertical} class="h-4 w-4" />
      </Button>
    {:else}
      <Button {variant} {size}>
        {triggerLabel}
        <ChevronDown class="ml-2 h-4 w-4" />
      </Button>
    {/if}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content {align} {sideOffset} {alignOffset} class="w-56 rounded-md border bg-background p-1 shadow-lg">
    <DropdownMenu.Group>
      {#each options as option (option.value)}
        <DropdownMenu.Item
          onSelect={() => executeAction(option)}
          class="relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
        >
          {option.label}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Group>
  </DropdownMenu.Content>
</DropdownMenu.Root>
