<script lang="ts">
  import { selectedPage } from "../../stores/fileSystemStore";
  import { writePageContent } from "../../stores/fileSystemActions";
  import ContentHeader from "./ContentHeader.svelte";
  import MarkdownEditor from "./MarkdownEditor.svelte";

  let content = "";
  let currentPath = "";

  $: if ($selectedPage) {
    // Only update content if the path has changed or content is not set
    if ($selectedPage.path !== currentPath || $selectedPage.content !== content) {
      content = $selectedPage.content || '';
      currentPath = $selectedPage.path;
    }
  }

  function handleContentChange(newContent: string) {
    content = newContent;
    if ($selectedPage) {
      writePageContent(content, $selectedPage.path);
    }
  }
</script>

<div class="h-full flex flex-col">
  {#if $selectedPage}
    <ContentHeader title={$selectedPage.title} />
  {/if}

  <div class="flex-1 overflow-hidden">
    {#if $selectedPage}
      <MarkdownEditor {content} onContentChange={handleContentChange} />
    {:else}
      <div class="p-8 text-center text-gray-500">
        <div class="text-4xl mb-4">📝</div>
        <h2 class="text-lg font-medium mb-2">No file selected</h2>
        <p class="text-sm">Select a file from the list to view its content</p>
      </div>
    {/if}
  </div>
</div>
