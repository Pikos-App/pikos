<script lang="ts">
  import { pages, selectedPage, selectedFolder } from "../stores/appStore";
  import type { Page } from "../stores/appStore";
  import type { FileInfo } from "../stores/appStore";

  export let directoryFiles: FileInfo[] = [];
  export let isLoading: boolean;

  let showCompleted = false;
  let filterType: "all" | "scheduled" | "unscheduled" = "all";

  function selectPage(page: Page) {
    selectedPage.set(page);
  }

  function selectFile(file: FileInfo) {
    // Convert FileInfo to Page and select it
    const page: Page = {
      id: file.path,
      title: file.name,
      path: file.path,
      isCompleted: false,
      scheduledAt: null,
    };
    selectedPage.set(page);
  }

  function toggleCompleted() {
    showCompleted = !showCompleted;
  }

  // Get files from the selected folder, or show empty if no folder selected
  $: currentFiles = $selectedFolder
    ? directoryFiles.filter(
        (file) =>
          !file.is_directory && file.path.startsWith($selectedFolder.path)
      )
    : [];
</script>

<div class="h-full flex flex-col">
  <!-- Header -->
  <div class="p-3 border-b border-gray-200">
    <div class="flex items-center justify-between mb-2">
      <h2 class="text-sm font-medium text-gray-900">Files</h2>
      <button class="text-xs text-gray-500 hover:text-gray-700"> + New </button>
    </div>

    <!-- Filter Tabs -->
    <div class="flex gap-1 mb-2">
      <button
        class="px-2 py-1 text-xs rounded transition-colors {filterType === 'all'
          ? 'bg-blue-500 text-white'
          : 'text-gray-500 hover:text-gray-700'}"
        on:click={() => (filterType = "all")}
      >
        All
      </button>
      <button
        class="px-2 py-1 text-xs rounded transition-colors {filterType ===
        'scheduled'
          ? 'bg-blue-500 text-white'
          : 'text-gray-500 hover:text-gray-700'}"
        on:click={() => (filterType = "scheduled")}
      >
        Scheduled
      </button>
      <button
        class="px-2 py-1 text-xs rounded transition-colors {filterType ===
        'unscheduled'
          ? 'bg-blue-500 text-white'
          : 'text-gray-500 hover:text-gray-700'}"
        on:click={() => (filterType = "unscheduled")}
      >
        Unscheduled
      </button>
    </div>

    <!-- Show Completed Toggle -->
    <button
      class="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1"
      on:click={toggleCompleted}
    >
      <input type="checkbox" bind:checked={showCompleted} class="w-3 h-3" />
      Show completed
    </button>
  </div>

  <!-- Files List -->
  <div class="flex-1 overflow-y-auto">
    {#if isLoading}
      <div class="p-4 text-center text-gray-500">Loading...</div>
    {:else if !$selectedFolder}
      <div class="p-4 text-center text-gray-500">
        Select a folder to view files
      </div>
    {:else if currentFiles.length === 0}
      <div class="p-4 text-center text-gray-500">
        No files found in this folder
      </div>
    {:else}
      {#each currentFiles as file (file.path)}
        <div class="border-b border-gray-200 last:border-b-0">
          <button
            class="w-full p-3 text-left hover:bg-gray-100 transition-colors {$selectedPage?.path ===
            file.path
              ? 'bg-blue-100'
              : ''}"
            on:click={() => selectFile(file)}
          >
            <div class="flex items-center gap-2">
              <div class="flex-1 min-w-0">
                <h3 class="text-sm font-medium text-gray-900 truncate">
                  {file.name}
                </h3>
              </div>
            </div>
          </button>
        </div>
      {/each}
    {/if}
  </div>
</div>
