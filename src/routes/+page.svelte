<script lang="ts">
  import { onMount } from "svelte";
  import Pages from "../components/Pages/Pages.svelte";
  import Content from "../components/Content/Content.svelte";
  import { pages, selectedFolder } from "../stores/fileSystemStore";
  import type { FileInfo } from "../stores/fileSystemStore";
  import Folders from "../components/Folders/Folders.svelte";
  import { readDirectory } from "../stores/fileSystemActions";

  let currentDirectory = "";
  let isLoading = false;
  let rootDirectoryFiles: FileInfo[] = []; // Keep track of root directory contents

  onMount(async () => {
    // Set a default directory for testing
    currentDirectory = "/Users/alex/Documents/pikos";
    await loadDirectory(currentDirectory);
  });

  async function loadDirectory(path: string) {
    isLoading = true;
    try {
      // Update current directory and selected folder
      currentDirectory = path;
      const folderName = path.split("/").pop() || "";
      // Set selected folder (triggers auto-load subscription in actions)
      if (folderName && path !== "/Users/alex/Documents/pikos") {
        selectedFolder.set({ id: path, name: folderName, path });
      } else {
        // Root: clear selected folder and load directly to also produce rootDirectoryFiles
        selectedFolder.set(null);
        const list = await readDirectory(path);
        if (Array.isArray(list)) {
          rootDirectoryFiles = list.map((p) => ({
            name: p.title,
            path: p.path,
            is_directory: p.is_directory,
            is_markdown: p.is_markdown,
          } satisfies FileInfo));
        }
      }
    } catch (error) {
      console.error("Failed to load directory:", error);
      // Fallback to empty array if directory read fails
      pages.set([]);
    } finally {
      isLoading = false;
    }
  }
</script>

<div class="flex h-screen bg-blue-100">
  <div class="w-48 border-r border-gray-300 bg-white">
    <Folders
      {currentDirectory}
      {rootDirectoryFiles}
      on:select-folder={(e: CustomEvent) => loadDirectory(e.detail.path)}
    />
  </div>

  <div class="w-72 border-r border-gray-300 bg-white">
    <Pages {isLoading} />
  </div>

  <div class="flex-1 bg-gray-50">
    <Content />
  </div>
</div>
