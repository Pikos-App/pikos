<script lang="ts">
  import { pages, selectedPage } from "../../stores/fileSystemStore";
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import ContentHeader from "./ContentHeader.svelte";

  let content = "";

  onMount(() => {
    loadPageContent();
  });

  async function loadPageContent() {
    if ($selectedPage) {
      try {
        content = await invoke("read_file", { filePath: $selectedPage.path });
      } catch (error) {
        console.error("Failed to load file content:", error);
        content = `# ${$selectedPage.title} Error loading file content.`;
      }
    }
  }

  let timeoutId: number;
  async function debouncedWritePageContent() {
    clearTimeout(timeoutId);

    timeoutId = setTimeout(() => {
      console.log("write content to file system");
      writePageContent();
    }, 500);
  }

  async function writePageContent() {
    if (!$selectedPage) return;

    try {
      await invoke("write_file", {
        filePath: $selectedPage.path,
        contents: content,
      });
    } catch (error) {
      console.error("Failed to save file content:", error);
      content = `# ${$selectedPage.title} Error saving file content.`;
    }
  }

  $: if ($selectedPage) loadPageContent();
</script>

<div class="h-full flex flex-col">
  {#if $selectedPage}
    <ContentHeader title={$selectedPage.title} />
  {/if}

  <div class="flex-1 overflow-y-auto">
    {#if !$selectedPage}
      <div class="p-8 text-center text-gray-500">
        <div class="text-4xl mb-4">📝</div>
        <h2 class="text-lg font-medium mb-2">No file selected</h2>
        <p class="text-sm">Select a file from the list to view its content</p>
      </div>
    {:else}
      <div class="h-full">
        <textarea
          bind:value={content}
          on:input={debouncedWritePageContent}
          class="w-full h-full p-4 bg-white text-gray-900 resize-none focus:outline-none font-mono text-sm"
          placeholder="Enter your markdown content here..."
        ></textarea>
      </div>
    {/if}
  </div>
</div>
