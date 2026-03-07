import { Sidebar } from "./Sidebar";
import { PageListPanel } from "./PageListPanel";
import { EditorPanel } from "./EditorPanel";
import { usePanelResize } from "./usePanelResize";

export function ThreePanelLayout() {
  const left = usePanelResize({
    storageKey: "pikos:leftPanelWidth",
    defaultWidth: 180,
    min: 120,
    max: 320,
  });
  const mid = usePanelResize({
    storageKey: "pikos:midPanelWidth",
    defaultWidth: 280,
    min: 180,
    max: 480,
  });

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar width={left.width} onResizeStart={left.onResizeStart} />
      <PageListPanel width={mid.width} onResizeStart={mid.onResizeStart} />
      <EditorPanel />
    </div>
  );
}
