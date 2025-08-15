<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import FolderSidebar from "../components/FolderSidebar.svelte";
  import PagesList from "../components/PagesList.svelte";
  import ContentPanel from "../components/ContentPanel.svelte";
  import { selectedFolder, pages } from "../stores/appStore";
  import type { FileInfo } from "../stores/appStore";

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
</script>

<div class="flex h-screen bg-blue-100">
  <!-- Left Panel - Directory List -->
  <div class="w-48 border-r border-gray-300 bg-white">
    <FolderSidebar
      {currentDirectory}
      {directoryFiles}
      {rootDirectoryFiles}
      on:select-folder={(e: CustomEvent) => loadDirectory(e.detail.path)}
    />
  </div>

  <!-- Middle Panel - Files in Directory -->
  <div class="w-72 border-r border-gray-300 bg-white">
    <PagesList {isLoading} {directoryFiles} />
  </div>

  <!-- Right Panel - Markdown Editor -->
  <div class="flex-1 bg-gray-50">
    <ContentPanel />
  </div>
</div>
