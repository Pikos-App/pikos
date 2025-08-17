<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { selectedFolder, pages } from "../../stores/appStore";
  import type { FileInfo } from "../../stores/appStore";
  import { createEventDispatcher } from "svelte";

  const dispatch = createEventDispatcher<{
    "file-created": { file: FileInfo };
  }>();

  let showFilters = false;
  let showCompleted = false;
  let filterType: "all" | "scheduled" | "unscheduled" = "all";

  function getUntitledCount() {
    const regex = /untitled\s*\d*\.md/;
    const matches = $pages.filter((page) => regex.test(page.title));
    return matches.length;
  }

  async function createFile() {
    if (!$selectedFolder) return;
    const untitledCount = getUntitledCount();
    const newFileName = !untitledCount ? "untitled.md" : `untitled ${getUntitledCount()}.md`;
    const newFilePath = $selectedFolder.path + "/" + newFileName;

    try {
      await invoke("create_file", {
        filePath: newFilePath,
      });

      // Create new FileInfo object for the created file
      const newFile: FileInfo = {
        name: newFileName,
        path: newFilePath,
        is_directory: false,
        is_markdown: true,
      };

      // Dispatch event to parent to add file to the list
      dispatch("file-created", { file: newFile });
    } catch (error) {
      console.error("Failed to create file:", error);
    }
  }

  function toggleCompleted() {
    showCompleted = !showCompleted;
  }
</script>

<div class="p-3 border-b border-gray-200">
  <div class="flex items-center justify-between">
    <h2 class="text-sm font-medium text-gray-900">Files</h2>
    <button on:click={createFile} class="text-xs text-gray-500 hover:text-gray-700"> + New </button>
  </div>

  {#if showFilters}
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

    <button class="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1" on:click={toggleCompleted}>
      <input type="checkbox" bind:checked={showCompleted} class="w-3 h-3" />
      Show completed
    </button>
  {/if}
</div>
