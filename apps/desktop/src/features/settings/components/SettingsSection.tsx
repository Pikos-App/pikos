// A titled block in a settings panel. Shared so a section that decides for itself
// whether it should appear at all can carry its own heading — hiding the contents
// and leaving the title behind is worse than showing neither.

import type { ReactNode } from "react";

export function SettingsSection({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-1 text-base font-semibold">{title}</h2>
      {description && <p className="mb-4 text-sm text-muted-foreground">{description}</p>}
      {children}
    </section>
  );
}
