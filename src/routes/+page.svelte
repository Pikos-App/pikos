<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import Pages from "../components/Pages/Pages.svelte";
  import Content from "../components/Content/Content.svelte";
  import { pages, selectedPage, selectedFolder } from "../stores/appStore";
  import type { FileInfo } from "../stores/appStore";
  import Folders from "../components/Folders/Folders.svelte";

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
      // Use Tauri command to read directory
      const files: FileInfo[] = await invoke("read_directory", {
        dirPath: path,
      });

      // If this is the initial load (root directory), store it separately
      if (path === "/Users/alex/Documents/pikos") {
        rootDirectoryFiles = files;
      }

      // Convert FileInfo to Page objects for all files
      const allPages = files.map((file, index) => ({
        id: index.toString(),
        title: file.name,
        path: file.path,
        isCompleted: false,
        scheduledAt: null,
        is_directory: file.is_directory,
        is_markdown: file.is_markdown,
      }));

      pages.set(allPages);

      // Update current directory and selected folder
      currentDirectory = path;

      // Find the folder that was selected and set it in the store
      const folderName = path.split("/").pop() || "";
      if (folderName && path !== "/Users/alex/Documents/pikos") {
        selectedFolder.set({
          id: path,
          name: folderName,
          path: path,
        });
      } else {
        // If we're at root, clear the selected folder to show all files
        selectedFolder.set(null);
      }
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

    // Add to pages store
    const newPage = {
      id: newFile.path,
      title: newFile.name,
      path: newFile.path,
      isCompleted: false,
      scheduledAt: null,
      is_directory: newFile.is_directory,
      is_markdown: newFile.is_markdown,
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
    <Pages {isLoading} on:file-created={handleFileCreated} />
  </div>

  <div class="flex-1 bg-gray-50">
    <Content />
  </div>
</div>
