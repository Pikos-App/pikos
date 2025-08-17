<script lang="ts">
  import { optimisticCreateFile } from "../../stores/fileSystemActions";

  let showFilters = false;
  let showCompleted = false;
  let filterType: "all" | "scheduled" | "unscheduled" = "all";

  function toggleCompleted() {
    showCompleted = !showCompleted;
  }
</script>

<div class="border-b border-gray-200">
  <div class="flex items-center justify-between h-10 px-3">
    <h2 class="text-sm font-medium text-gray-900">Files</h2>
    <button on:click={optimisticCreateFile} class="text-xs text-gray-500 hover:text-gray-700"> + New </button>
  </div>

  {#if showFilters}
    <div class="flex gap-1 mb-2 px-3">
      <button
        class="px-2 py-1 text-xs rounded transition-colors {filterType === 'all'
          ? 'bg-blue-500 text-white'
          : 'text-gray-500 hover:text-gray-700'}"
        on:click={() => (filterType = "all")}
      >
        All
      </button>
      <button
        class="px-2 py-1 text-xs rounded transition-colors {filterType === 'scheduled'
          ? 'bg-blue-500 text-white'
          : 'text-gray-500 hover:text-gray-700'}"
        on:click={() => (filterType = "scheduled")}
      >
        Scheduled
      </button>
      <button
        class="px-2 py-1 text-xs rounded transition-colors {filterType === 'unscheduled'
          ? 'bg-blue-500 text-white'
          : 'text-gray-500 hover:text-gray-700'}"
        on:click={() => (filterType = "unscheduled")}
      >
        Unscheduled
      </button>
    </div>

    <button class="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1 px-3" on:click={toggleCompleted}>
      <input type="checkbox" bind:checked={showCompleted} class="w-3 h-3" />
      Show completed
    </button>
  {/if}
</div>
