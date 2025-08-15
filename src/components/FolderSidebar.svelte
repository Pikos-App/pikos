<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { selectedFolder } from "../stores/appStore";
  import type { Folder } from "../stores/appStore";
  import type { FileInfo } from "../stores/appStore";

  export let currentDirectory: string = "";
  export let directoryFiles: FileInfo[] = [];
  export let rootDirectoryFiles: FileInfo[] = [];

  const dispatch = createEventDispatcher<{
    "select-folder": { path: string };
  }>();

  function selectFolder(folder: Folder) {
    selectedFolder.set(folder);
    dispatch("select-folder", { path: folder.path });
  }

  // Get the current directory name for display
  $: currentDirName = currentDirectory.split("/").pop() || "Root";

  // Extract directories from the root directory files (always show root folders)
  $: directories = rootDirectoryFiles
    .filter((file) => file.is_directory)
    .map((file, index) => ({
      id: index.toString(),
      name: file.name,
      path: file.path,
      color: getFolderColor(file.name),
    }));

  function getFolderColor(folderName: string): string {
    const colors = [
      "#3b82f6", // blue
      "#10b981", // green
      "#f59e0b", // yellow
      "#8b5cf6", // purple
      "#ef4444", // red
      "#06b6d4", // cyan
      "#84cc16", // lime
      "#f97316", // orange
    ];

    const hash = folderName.split("").reduce((a, b) => {
      a = (a << 5) - a + b.charCodeAt(0);
      return a & a;
    }, 0);

    return colors[Math.abs(hash) % colors.length];
  }
</script>

<div class="h-full flex flex-col">
  <!-- Header -->
  <div class="p-3 border-b border-gray-200">
    <h2 class="text-sm font-medium text-gray-900">Folders</h2>
  </div>

  <!-- Directory List -->
  <div class="flex-1 overflow-y-auto">
    <!-- All Directories (always visible) -->
    {#each directories as folder (folder.id)}
      <div class="border-b border-gray-200 last:border-b-0">
        <button
          class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-100 transition-colors {$selectedFolder?.path ===
          folder.path
            ? 'bg-blue-100 text-blue-900'
            : 'text-gray-700'}"
          on:click={() => selectFolder(folder)}
        >
          <div
            class="w-2 h-2 rounded-full flex-shrink-0"
            style="background-color: {folder.color || '#6b7280'}"
          ></div>
          <span class="text-sm truncate">{folder.name}</span>
        </button>
      </div>
    {/each}
  </div>

  <!-- Add Directory Button -->
  <div class="p-3 border-t border-gray-200">
    <button
      class="w-full px-2 py-1 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"
    >
      + Add Directory
    </button>
  </div>
</div>
