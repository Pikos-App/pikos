// Auto-dismisses after `duration` ms; hovering pauses dismissal and resets
// the remaining time.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: string;
  label: string;
  /** Per-item duration override. Falls back to the component-level `duration` prop. */
  duration?: number;
  /** Optional action button. Action's onClick is responsible for any cleanup. */
  action?: ToastAction;
}

interface ToastProps {
  items: ToastItem[];
  duration?: number;
  /** Fires when the timer expires (no action taken). */
  onDismiss: (id: string) => void;
}

function SingleToast({
  duration: defaultDuration = 5000,
  item,
  onDismiss,
}: {
  item: ToastItem;
  duration: number;
  onDismiss: (id: string) => void;
}) {
  const duration = item.duration ?? defaultDuration;
  const [progress, setProgress] = useState(1);
  const stateRef = useRef({
    dismissed: false,
    hovering: false,
    raf: null as number | null,
    remaining: duration,
    startTime: null as number | null,
  });

  // Keep callbacks in a ref so the RAF loop always sees the latest versions
  const callbacksRef = useRef({ action: item.action, onDismiss });
  useEffect(() => {
    callbacksRef.current = { action: item.action, onDismiss };
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

  function handleAction() {
    const s = stateRef.current;
    if (s.dismissed) return;
    s.dismissed = true;
    if (s.raf !== null) cancelAnimationFrame(s.raf);
    item.action?.onClick();
  }

  const action = item.action;

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      aria-label={item.label}
      className="relative flex w-80 items-center gap-3 overflow-hidden rounded-lg border border-border bg-popover px-3 py-2.5 shadow-lg"
      exit={{ opacity: 0, y: 8 }}
      initial={{ opacity: 0, y: 8 }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      role={action ? "alert" : "status"}
      transition={{ duration: 0.18 }}
    >
      <span className="flex-1 truncate text-sm text-foreground">{item.label}</span>
      {action && (
        <button
          aria-label={action.label}
          className="shrink-0 text-xs font-medium text-primary hover:text-primary/80"
          onClick={handleAction}
        >
          {action.label}
        </button>
      )}
      <div className="absolute bottom-0 left-0 h-[2px] w-full bg-primary/20">
        <div
          className="h-full bg-primary/50 transition-none"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </motion.div>
  );
}

export function Toast({ duration = 5000, items, onDismiss }: ToastProps) {
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2">
      <AnimatePresence mode="popLayout">
        {items.map((item) => (
          <div className="pointer-events-auto" key={item.id}>
            <SingleToast duration={duration} item={item} onDismiss={onDismiss} />
          </div>
        ))}
      </AnimatePresence>
    </div>
  );
}
