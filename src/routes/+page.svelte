<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import Pages from "../components/Pages/Pages.svelte";
  import Content from "../components/Content/Content.svelte";
  import { pages, selectedPage } from "../stores/appStore";
  import type { FileInfo } from "../stores/appStore";
  import Folders from "../components/Folders/Folders.svelte";

  let currentDirectory = "";
  let isLoading = false;
  let directoryFiles: FileInfo[] = [];
  let rootDirectoryFiles: FileInfo[] = []; // Keep track of root directory contents

  onMount(async () => {
    // Set a default directory for testing
    currentDirectory = "/Users/alex/Documents/pikos";
    await loadDirectory(currentDirectory);
  });

  async function loadDirectory(path: string) {
    isLoading = true;
    try {
      // Use Tauri command to read directory
      const files: FileInfo[] = await invoke("read_directory", {
        dirPath: path,
      });

      // Store all files for the sidebar
      directoryFiles = files;

      // If this is the initial load (root directory), store it separately
      if (path === "/Users/alex/Documents/pikos") {
        rootDirectoryFiles = files;
      }

      // Convert FileInfo to Page objects for markdown files
      const markdownPages = files
        .filter((file) => file.is_markdown)
        .map((file, index) => ({
          id: index.toString(),
          title: file.name,
          path: file.path,
          isCompleted: false,
          scheduledAt: null,
        }));

      pages.set(markdownPages);

      // Update current directory
      currentDirectory = path;

      // Don't automatically select a folder - let user choose
      // selectedFolder.set(null);
    } catch (error) {
      console.error("Failed to load directory:", error);
      // Fallback to empty array if directory read fails
      pages.set([]);
    } finally {
      isLoading = false;
    }
  }

  function handleFileCreated(event: CustomEvent<{ file: FileInfo }>) {
    const newFile = event.detail.file;

    // Add the new file to the directoryFiles array
    directoryFiles = [...directoryFiles, newFile];

    // Also add to pages store for consistency
    const newPage = {
      id: newFile.path,
      title: newFile.name,
      path: newFile.path,
      isCompleted: false,
      scheduledAt: null,
    };

    pages.update((currentPages) => [...currentPages, newPage]);

    // Automatically select the newly created file
    selectedPage.set(newPage);
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
    <Pages {isLoading} {directoryFiles} on:file-created={handleFileCreated} />
  </div>

  <div class="flex-1 bg-gray-50">
    <Content />
  </div>
</div>
