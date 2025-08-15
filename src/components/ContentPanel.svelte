<script lang="ts">
  import { selectedPage } from "../stores/appStore";
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";

  let content = "";
  let isEditing = false;

  onMount(() => {
    loadPageContent();
  });

  async function loadPageContent() {
    if ($selectedPage) {
      try {
        // Load actual file content from Tauri
        content = await invoke("read_file", { filePath: $selectedPage.path });
      } catch (error) {
        console.error("Failed to load file content:", error);
        content = `# ${$selectedPage.title}

Error loading file content.`;
      }
    }
  }

  // Watch for selected page changes
  $: if ($selectedPage) {
    loadPageContent();
  }

  function toggleEdit() {
    isEditing = !isEditing;
  }

  function saveContent() {
    // Save content logic here
    isEditing = false;
  }
</script>

<div class="h-full flex flex-col">
  <!-- Header -->
  <div class="p-3 border-gray-200">
    <div class="flex items-center justify-between">
      {#if $selectedPage}
        <div class="flex gap-2">
          {#if isEditing}
            <button
              class="px-2 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
              on:click={saveContent}
            >
              Save
            </button>
            <button
              class="px-2 py-1 text-xs text-gray-500 hover:text-gray-700 rounded transition-colors"
              on:click={() => (isEditing = false)}
            >
              Cancel
            </button>
          {:else}
            <button
              class="px-2 py-1 text-xs text-gray-500 hover:text-gray-700 rounded transition-colors"
              on:click={toggleEdit}
            >
              Edit
            </button>
          {/if}
        </div>
      {/if}
    </div>
  </div>

  <!-- Content Area -->
  <div class="flex-1 overflow-y-auto">
    {#if !$selectedPage}
      <div class="p-8 text-center text-gray-500">
        <div class="text-4xl mb-4">📝</div>
        <h2 class="text-lg font-medium mb-2">No file selected</h2>
        <p class="text-sm">Select a file from the list to view its content</p>
      </div>
    {:else}
      <div class="h-full">
        {#if isEditing}
          <textarea
            bind:value={content}
            class="w-full h-full p-4 bg-white text-gray-900 resize-none focus:outline-none font-mono text-sm"
            placeholder="Enter your markdown content here..."
          ></textarea>
        {:else}
          <div class="p-4">
            <pre
              class="whitespace-pre-wrap font-mono text-sm text-gray-900">{content}</pre>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>
