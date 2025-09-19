<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";

  export let open = false;
  export let onClose: () => void = () => {};
  export let size: "sm" | "md" | "lg" | "xl" | "2xl" = "md";

  const sizeClasses = {
    sm: "max-w-sm",
    md: "max-w-md",
    lg: "max-w-lg",
    xl: "max-w-xl",
    "2xl": "max-w-2xl",
  };

  $: modalClass = `w-full ${sizeClasses[size] || sizeClasses["md"]} p-4`;

  function handleOpenChange(isOpen: boolean) {
    if (!isOpen) {
      onClose();
    }
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content class={modalClass}>
    <div>
      <slot />
    </div>
  </Dialog.Content>
</Dialog.Root>
