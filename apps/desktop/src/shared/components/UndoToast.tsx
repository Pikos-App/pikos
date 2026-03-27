// UndoToast — animated toast with undo action.
// Auto-dismisses after `duration` ms. Pauses dismissal while the mouse is over the toast.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

export interface UndoToastItem {
  id: string;
  label: string;
}

interface UndoToastProps {
  items: UndoToastItem[];
  duration?: number;
  onUndo: (id: string) => void;
  onDismiss: (id: string) => void;
}

function SingleToast({
  duration = 5000,
  item,
  onDismiss,
  onUndo,
}: {
  item: UndoToastItem;
  duration: number;
  onUndo: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const [progress, setProgress] = useState(1);
  const stateRef = useRef({
    dismissed: false,
    hovering: false,
    raf: null as number | null,
    remaining: duration,
    startTime: null as number | null,
  });

  // Keep callbacks in a ref so the RAF loop always sees the latest versions
  const callbacksRef = useRef({ onDismiss, onUndo });
  useEffect(() => {
    callbacksRef.current = { onDismiss, onUndo };
  });

  useEffect(() => {
    const s = stateRef.current;

    function tick(now: number) {
      if (s.dismissed) return;

      if (s.hovering) {
        s.startTime = null;
        s.raf = requestAnimationFrame(tick);
        return;
      }

      if (s.startTime === null) s.startTime = now;
      const elapsed = now - s.startTime;
      const left = s.remaining - elapsed;

      if (left <= 0) {
        setProgress(0);
        s.dismissed = true;
        callbacksRef.current.onDismiss(item.id);
        return;
      }

      setProgress(left / duration);
      s.raf = requestAnimationFrame(tick);
    }

    s.raf = requestAnimationFrame(tick);
    return () => {
      if (s.raf !== null) cancelAnimationFrame(s.raf);
    };
    // Only run on mount — the tick closure captures `s` by ref, which is stable.
  }, []);

  function handleMouseEnter() {
    const s = stateRef.current;
    s.hovering = true;
    s.remaining = duration;
    s.startTime = null;
    setProgress(1);
  }

  function handleMouseLeave() {
    stateRef.current.hovering = false;
    stateRef.current.startTime = null;
  }

  function handleUndo() {
    const s = stateRef.current;
    if (s.dismissed) return;
    s.dismissed = true;
    if (s.raf !== null) cancelAnimationFrame(s.raf);
    onUndo(item.id);
  }

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="relative flex w-80 items-center gap-3 overflow-hidden rounded-lg border border-border bg-popover px-3 py-2.5 shadow-lg"
      exit={{ opacity: 0, y: 8 }}
      initial={{ opacity: 0, y: 8 }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      transition={{ duration: 0.18 }}
    >
      <span className="flex-1 truncate text-sm text-foreground">
        Deleted <span className="font-medium">&ldquo;{item.label || "Untitled"}&rdquo;</span>
      </span>
      <button
        className="shrink-0 text-xs font-medium text-primary hover:text-primary/80"
        onClick={handleUndo}
      >
        Undo
      </button>
      {/* Progress bar */}
      <div className="absolute bottom-0 left-0 h-[2px] w-full bg-primary/20">
        <div
          className="h-full bg-primary/50 transition-none"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </motion.div>
  );
}

export function UndoToast({ duration = 5000, items, onDismiss, onUndo }: UndoToastProps) {
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2">
      <AnimatePresence mode="popLayout">
        {items.map((item) => (
          <div className="pointer-events-auto" key={item.id}>
            <SingleToast duration={duration} item={item} onDismiss={onDismiss} onUndo={onUndo} />
          </div>
        ))}
      </AnimatePresence>
    </div>
  );
}
