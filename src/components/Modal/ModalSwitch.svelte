<script lang="ts">
  import { modal } from "../../stores/uiStore";
  import PageSwitcher from "../Modals/PageSwitcher.svelte";

  function handleClose() {
    modal.close('page-switcher');
  }
</script>

{#if $modal?.current === 'page-switcher'}
  <PageSwitcher onClose={handleClose} />
{/if}
