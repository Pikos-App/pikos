<script lang="ts">
  import { selectedPage, selectedFolder, pages } from "../../stores/fileSystemStore";
  import type { Page } from "../../stores/fileSystemStore";
  import PagesHeader from "./PagesHeader.svelte";
  export let isLoading: boolean;

  function selectFile(page: Page) {
    selectedPage.set(page);
  }

  $: currentFiles = $selectedFolder
    ? $pages.filter((page) => !page.is_directory && page.path.startsWith($selectedFolder.path))
    : $pages.filter((page) => !page.is_directory);
</script>

<div class="h-full flex flex-col">
  <PagesHeader />

  <div class="flex-1 overflow-y-auto">
    {#if isLoading}
      <div class="p-4 text-center text-gray-500">Loading...</div>
    {:else if currentFiles.length === 0}
      <div class="p-4 text-center text-gray-500">No files found in this folder</div>
    {:else}
      {#each currentFiles as page (page.path)}
        <div class="border-b border-gray-200 last:border-b-0">
          <button
            class="w-full px-3 py-2 text-left hover:bg-gray-100 transition-colors {$selectedPage?.path === page.path
              ? 'bg-blue-100'
              : ''}"
            on:click={() => selectFile(page)}
          >
            <div class="flex items-center gap-2">
              <div class="flex-1 min-w-0">
                <h3 class="text-sm font-medium text-gray-900 truncate">
                  {page.title}
                </h3>
              </div>
            </div>
          </button>
        </div>
      {/each}
    {/if}
  </div>
</div>
