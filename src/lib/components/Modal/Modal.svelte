<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";

  export let open = false;
  export let onClose: () => void = () => {};
  export let title: string = "";
  export let description: string = "";
  export let showCloseButton: boolean = true;
  export let size: "sm" | "md" | "lg" | "xl" | "2xl" = "md";

  const sizeClasses = {
    sm: "max-w-sm",
    md: "max-w-md",
    lg: "max-w-lg",
    xl: "max-w-xl",
    "2xl": "max-w-2xl",
  };

  $: modalClass = `w-full ${sizeClasses[size] || sizeClasses["md"]}`;

  function handleOpenChange(isOpen: boolean) {
    if (!isOpen) {
      onClose();
    }
  }
</script>

<Dialog.Root open={open} onOpenChange={handleOpenChange}>
  <Dialog.Content class={modalClass}>
    <div class="flex items-center justify-between mb-4">
      <div>
        {#if title}
          <Dialog.Title class="text-lg font-semibold text-gray-900 dark:text-white">
            {title}
          </Dialog.Title>
        {/if}
        {#if description}
          <Dialog.Description class="text-sm text-gray-500 dark:text-gray-400">
            {description}
          </Dialog.Description>
        {/if}
      </div>
      {#if showCloseButton}
        <Dialog.Close>
          <Button variant="ghost" size="icon" class="h-8 w-8 p-0">
            <span class="sr-only">Close</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="h-4 w-4"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </Button>
        </Dialog.Close>
      {/if}
    </div>
    <div class="py-4">
      <slot />
    </div>
  </Dialog.Content>
</Dialog.Root>
