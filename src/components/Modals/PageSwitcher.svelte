<script lang="ts">
  import { onMount } from "svelte";
  import { pages, selectedPage } from "../../stores/fileSystemStore";
  import { recentPages } from "../../stores/recentPagesStore";
  import { readPageContent } from "../../stores/fileSystemActions";
  import Modal from "$lib/components/Modal/Modal.svelte";
  import type { Page } from "../../stores/fileSystemStore";

  export let onClose: () => void;

  let searchInput: HTMLInputElement;
  let searchQuery = "";
  let selectedIndex = 0;
  let resultsContainer: HTMLDivElement;

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose?.();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const items = searchQuery ? filteredPages : $recentPages;
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
      scrollIntoView();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      scrollIntoView();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (searchQuery === "" && $recentPages.length > 0) {
        // If search is empty, use the selected recent page or the first one
        const targetIndex = selectedIndex >= 0 ? selectedIndex : 0;
        handleSelect($recentPages[targetIndex]);
      } else if (filteredPages[selectedIndex]) {
        handleSelect(filteredPages[selectedIndex]);
      } else if (filteredPages.length > 0) {
        handleSelect(filteredPages[0]);
      }
    }
  }

  function scrollIntoView() {
    const selectedElement = resultsContainer?.querySelector('[data-selected="true"]');
    selectedElement?.scrollIntoView({ block: "nearest" });
  }

  async function handleSelect(page: Page) {
    if (!page) return;

    // First update the selected page to trigger content loading
    selectedPage.set({ ...page, content: undefined });

    // Add to recent pages
    recentPages.addPage(page);

    // Close the modal
    onClose?.();

    // Force content reload after a small delay to ensure UI updates
    setTimeout(async () => {
      const path = page.path;
      if (path) {
        await readPageContent(path);
      }
    }, 50);
  }

  function highlightText(text: string, query: string) {
    if (!query.trim()) return text;
    const terms = query
      .toLowerCase()
      .split(" ")
      .filter((term) => term.length > 0);
    let result = text;

    terms.forEach((term) => {
      const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
      result = result.replace(regex, '<span class="bg-yellow-100 dark:bg-yellow-900">$1</span>');
    });

    return result;
  }

  function fuzzyMatch(text: string, query: string): boolean {
    const terms = query
      .toLowerCase()
      .split(" ")
      .filter((term) => term.length > 0);
    const lowerText = text.toLowerCase();
    return terms.every((term) => lowerText.includes(term));
  }

  $: filteredPages = $pages
    // Filter for markdown files only
    .filter((page: Page) => page.is_markdown)
    // Filter by search query if present
    .filter((page: Page) => {
      if (!searchQuery.trim()) return false;
      const searchIn = `${page.title} ${page.path}`.toLowerCase();
      return fuzzyMatch(searchIn, searchQuery);
    })
    // Sort by most recently modified (if available) or alphabetically
    .sort((a: Page, b: Page) => {
      if (a.updatedAt && b.updatedAt) {
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }
      return a.title.localeCompare(b.title);
    });

  // Reset selected index when search query changes
  $: if (searchQuery) selectedIndex = 0;

  onMount(() => {
    setTimeout(() => searchInput?.focus(), 10);
  });
</script>

<Modal open {onClose} size="md">
  <div class="h-[300px] flex flex-col">
    <div class="flex-shrink-0">
      <input
        bind:this={searchInput}
        bind:value={searchQuery}
        type="text"
        placeholder="Search pages..."
        on:keydown={handleKeyDown}
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        class="w-full p-2 border rounded-sm focus:outline-none focus:ring-1 text-base"
        aria-label="Search pages"
      />
    </div>
    <div class="mt-2 flex-1 overflow-y-auto" bind:this={resultsContainer}>
      {#if searchQuery === ""}
        {#each $recentPages as page, index (page.path)}
          <div
            class="p-3 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-md cursor-pointer transition-colors {selectedIndex ===
            index
              ? 'bg-blue-50 dark:bg-gray-700'
              : ''}"
            role="button"
            tabindex="0"
            data-selected={selectedIndex === index && searchQuery === ""}
            on:keydown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleSelect(page);
              }
            }}
            on:click={(e) => {
              e.stopPropagation();
              handleSelect(page);
            }}
            on:mouseenter={() => (selectedIndex = index)}
          >
            <div class="font-medium">{page.title}</div>
          </div>
        {/each}
      {:else if filteredPages.length === 0}
        <div class="text-center py-4 text-gray-500 dark:text-gray-400">
          No pages found matching "{searchQuery}"
        </div>
      {:else}
        {#each filteredPages as page, index (page.path)}
          <div
            class="p-2 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-md cursor-pointer transition-colors {selectedIndex ===
            index
              ? 'bg-blue-50 dark:bg-gray-700'
              : ''}"
            role="button"
            tabindex="0"
            data-selected={selectedIndex === index}
            on:keydown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleSelect(page);
              }
            }}
            on:click={(e) => {
              e.stopPropagation();
              handleSelect(page);
            }}
            on:mouseenter={() => (selectedIndex = index)}
          >
            <div class="font-medium">{@html highlightText(page.title, searchQuery)}</div>
          </div>
        {/each}
      {/if}
    </div>
  </div>
</Modal>
