<script>
  import "../app.css";
  import ModalSwitch from "../components/Modal/ModalSwitch.svelte";

  function refreshApp() {
    // Full app reload (works in Tauri webview and browser)
    window.location.reload();
  }
</script>

<div class="h-screen flex flex-col bg-background">
  <slot />

  <ModalSwitch />

  <div class="fixed bottom-4 right-4 z-50">
    <button
      type="button"
      aria-label="Refresh application"
      title="Refresh"
      class="rounded-full shadow-md bg-blue-600 hover:bg-blue-700 text-white w-12 h-12 flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2"
      on:click={refreshApp}
    >
      ↻
    </button>
  </div>
</div>
