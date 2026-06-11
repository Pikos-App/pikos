// DataSettings still has its own local copy of this wrapper, pending unification.

import type { ReactNode } from "react";

interface SettingsSectionProps {
  title: string;
  description?: string;
  children: ReactNode;
}

export function SettingsSection({ children, description, title }: SettingsSectionProps) {
  return (
    <section className="mb-8">
      <div className="mb-4">
        <h2 className="text-base font-semibold">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}
