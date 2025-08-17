<script lang="ts">
  import { selectedPage } from "../../stores/fileSystemStore";
  import { writePageContent } from "../../stores/fileSystemActions";
  import ContentHeader from "./ContentHeader.svelte";

  let content: string = "";
  let loadedPath: string | null = null;
  let isFocused: boolean = false;

  // When selection changes, initialize local content from store
  $: if ($selectedPage?.path && $selectedPage.path !== loadedPath) {
    content = $selectedPage.content ?? "";
    loadedPath = $selectedPage.path;
  }

  // When the content for the currently loaded path updates (e.g., after async load),
  // sync the editor if the user isn't actively typing.
  $: if (
    $selectedPage?.path &&
    $selectedPage.path === loadedPath &&
    !isFocused &&
    typeof $selectedPage.content === "string" &&
    $selectedPage.content !== content
  ) {
    content = $selectedPage.content;
  }

  let timeoutId: number;
  async function debouncedWritePageContent() {
    clearTimeout(timeoutId);

    timeoutId = setTimeout(() => {
      if ($selectedPage) writePageContent(content, $selectedPage.path);
    }, 500);
  }
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
      <div class="h-full overflow-y-hidden">
        <textarea
          bind:value={content}
          on:input={debouncedWritePageContent}
          on:focus={() => (isFocused = true)}
          on:blur={() => (isFocused = false)}
          class="w-full h-full p-4 bg-white text-gray-900 resize-none focus:outline-none font-mono text-sm"
          placeholder="Enter your markdown content here..."
        ></textarea>
      </div>
    {/if}
  </div>
</div>
