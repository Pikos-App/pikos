<script lang="ts">
  import { selectedPage, selectedFolder } from "../../stores/appStore";
  import type { Page } from "../../stores/appStore";
  import type { FileInfo } from "../../stores/appStore";
  import PagesHeader from "./PagesHeader.svelte";
  export let directoryFiles: FileInfo[] = [];
  export let isLoading: boolean;

  function selectFile(file: FileInfo) {
    const page: Page = {
      id: file.path,
      title: file.name,
      path: file.path,
      isCompleted: false,
      scheduledAt: null,
    };
    selectedPage.set(page);
  }

  $: currentFiles = $selectedFolder
    ? directoryFiles.filter(
        (file) =>
          !file.is_directory && file.path.startsWith($selectedFolder.path)
      )
    : [];
</script>

<div class="h-full flex flex-col">
  <PagesHeader {directoryFiles} on:file-created />

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
            class="w-full px-3 py-2 text-left hover:bg-gray-100 transition-colors {$selectedPage?.path ===
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
