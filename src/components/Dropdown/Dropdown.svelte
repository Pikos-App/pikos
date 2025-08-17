<script lang="ts">
  let isOpen = false;

  export let options: { label: string; value: string; onClick?: () => void }[] = [];

  function executeAction(option: { label: string; value: string; onClick?: () => void }) {
    isOpen = false;
    if (option.onClick) {
      option.onClick();
    }
  }

  function handleClickOutside(event: MouseEvent) {
    if (!event.target) return;
    const target = event.target as Element;
    if (!target.closest(".dropdown-container")) {
      isOpen = false;
    }
  }
</script>

<svelte:window on:click={handleClickOutside} />

<div class="dropdown-container relative inline-block">
  <button
    on:click={() => (isOpen = !isOpen)}
    class="p-1.5 inline-flex items-center justify-center rounded-lg hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors duration-200"
    class:bg-gray-100={isOpen}
    aria-label="More options"
  >
    <!-- Kebab menu icon (three vertical dots) -->
    <svg class="w-4 h-4 text-gray-600" fill="currentColor" viewBox="0 0 20 20">
      <circle cx="10" cy="4" r="2" />
      <circle cx="10" cy="10" r="2" />
      <circle cx="10" cy="16" r="2" />
    </svg>
  </button>

  {#if isOpen}
    <div class="absolute right-0 z-10 mt-1 w-48 bg-white border border-gray-200 rounded-lg shadow-lg">
      {#each options as option}
        <button
          on:click={() => executeAction(option)}
          class="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 hover:text-gray-900 focus:outline-none focus:bg-gray-50 transition-colors duration-150 first:rounded-t-lg last:rounded-b-lg"
        >
          {option.label}
        </button>
      {/each}
    </div>
  {/if}
</div>
