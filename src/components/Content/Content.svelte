<script lang="ts">
  import { selectedPage } from "../../stores/appStore";
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";

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

  function closePage() {
    selectedPage.set(null);
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
  <div class="p-3 border-gray-200">
    {#if $selectedPage}
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-medium text-gray-900">
          {$selectedPage?.title}
        </h2>
        <button on:click={closePage} class="text-xs text-gray-500 hover:text-gray-700">x</button>
      </div>
    {/if}
  </div>

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
