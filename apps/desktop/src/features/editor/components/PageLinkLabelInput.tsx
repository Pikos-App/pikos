import { type Ref, useRef, useState } from "react";

interface PageLinkLabelInputProps {
  initial: string;
  inputRef: Ref<HTMLInputElement>;
  onCancel: () => void;
  onCommit: (text: string) => void;
  title: string;
}

/** Edits the text a page link shows. Left empty, the link goes back to showing its page's title. */
export function PageLinkLabelInput({
  initial,
  inputRef,
  onCancel,
  onCommit,
  title,
}: PageLinkLabelInputProps) {
  const [value, setValue] = useState(initial);
  // WebKit can blur the input as it unmounts, which would commit a cancelled edit.
  const isSettledRef = useRef(false);

  function settle(finish: () => void) {
    if (isSettledRef.current) return;

    isSettledRef.current = true;
    finish();
  }

  return (
    <input
      aria-label="Link text"
      className="page-link page-link-input"
      onBlur={() => settle(() => onCommit(value))}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          settle(() => onCommit(value));
        } else if (e.key === "Escape") {
          e.preventDefault();
          settle(onCancel);
        }
      }}
      placeholder={title || "Untitled"}
      ref={inputRef}
      size={Math.max(value.length, title.length, 4) + 1}
      spellCheck={false}
      value={value}
    />
  );
}
