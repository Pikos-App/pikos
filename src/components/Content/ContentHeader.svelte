<script lang="ts">
  import Dropdown from "../Dropdown/Dropdown.svelte";
  import { selectedPage } from "../../stores/fileSystemStore";
  import { deletePage, optimisticDeletePage } from "../../stores/fileSystemActions";

  export let title: string;

  function closePage() {
    selectedPage.set(null);
  }

  let options = [
    { label: "Close", value: "close", onClick: closePage },
    { label: "Delete", value: "delete", onClick: optimisticDeletePage },
  ];
</script>

<div class="flex items-center justify-between h-10 px-3 border-b border-gray-200">
  <h2 class="text-sm font-medium text-gray-900">{title}</h2>
  <Dropdown {options} />
</div>
