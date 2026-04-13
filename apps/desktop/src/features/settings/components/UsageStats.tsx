// UsageStats — rich local usage statistics panel for Settings > Data.
// All data comes from SQL queries against the local DB. No telemetry.

import {
  BarChart3,
  BookOpen,
  Calendar,
  CheckCircle2,
  Clock,
  FileText,
  Flag,
  FolderOpen,
  Hash,
  Layers,
  Timer,
} from "lucide-react";

import { cn } from "@/lib/utils";

interface WeekActivity {
  week: string;
  created: number;
  edited: number;
  completed: number;
}

export interface UsageStatsData {
  total_pages: number;
  total_folders: number;
  total_schedules: number;
  total_focus_sessions: number;
  total_focus_minutes: number;
  total_completed: number;
  total_words: number;
  weekly_activity: WeekActivity[];
  has_folders: boolean;
  has_schedules: boolean;
  has_recurring: boolean;
  has_focus_sessions: boolean;
  has_subtasks: boolean;
  has_tags: boolean;
  has_priorities: boolean;
  first_page_date: string | null;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

function formatMinutes(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function daysSince(dateStr: string): number {
  const d = new Date(dateStr);
  const now = new Date();
  return Math.floor((now.getTime() - d.getTime()) / 86_400_000);
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function StatCard({
  icon: Icon,
  label,
  sub,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-xs">{label}</span>
      </div>
      <span className="text-xl font-semibold tracking-tight tabular-nums">{value}</span>
      {sub && <span className="text-[11px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

function ActivityChart({ weeks }: { weeks: WeekActivity[] }) {
  const maxVal = Math.max(1, ...weeks.map((w) => Math.max(w.created, w.edited, w.completed)));

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-1" style={{ height: 64 }}>
        {weeks.map((w) => {
          const createdH = (w.created / maxVal) * 56;
          const editedH = (w.edited / maxVal) * 56;
          const completedH = (w.completed / maxVal) * 56;
          return (
            <div
              className="group relative flex flex-1 items-end justify-center gap-px"
              key={w.week}
            >
              <div
                className="w-full max-w-[7px] rounded-t-sm bg-blue-500/60 transition-colors group-hover:bg-blue-500"
                style={{ height: Math.max(createdH, w.created > 0 ? 2 : 0) }}
                title={`${w.week}: ${w.created} created`}
              />
              <div
                className="w-full max-w-[7px] rounded-t-sm bg-violet-500/60 transition-colors group-hover:bg-violet-500"
                style={{ height: Math.max(editedH, w.edited > 0 ? 2 : 0) }}
                title={`${w.week}: ${w.edited} edited`}
              />
              <div
                className="w-full max-w-[7px] rounded-t-sm bg-emerald-500/60 transition-colors group-hover:bg-emerald-500"
                style={{ height: Math.max(completedH, w.completed > 0 ? 2 : 0) }}
                title={`${w.week}: ${w.completed} completed`}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{weeks[0]?.week}</span>
        <span>{weeks[weeks.length - 1]?.week}</span>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-2 rounded-full bg-blue-500/60" />
          <span className="text-xs text-muted-foreground">Created</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-2 rounded-full bg-violet-500/60" />
          <span className="text-xs text-muted-foreground">Edited</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-2 rounded-full bg-emerald-500/60" />
          <span className="text-xs text-muted-foreground">Completed</span>
        </div>
      </div>
    </div>
  );
}

function FeatureBadge({
  active,
  icon: Icon,
  label,
}: {
  active: boolean;
  icon: React.ElementType;
  label: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
        active
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
          : "border-border bg-muted/50 text-muted-foreground/50"
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </div>
  );
}

export function UsageStats({ stats }: { stats: UsageStatsData | null }) {
  if (!stats) return null;

  const memberDays = stats.first_page_date ? daysSince(stats.first_page_date) : 0;

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-2">
        <StatCard icon={FileText} label="Pages" value={formatNumber(stats.total_pages)} />
        <StatCard icon={BookOpen} label="Words" value={formatNumber(stats.total_words)} />
        <StatCard
          icon={CheckCircle2}
          label="Completed"
          value={formatNumber(stats.total_completed)}
        />
        <StatCard icon={FolderOpen} label="Folders" value={formatNumber(stats.total_folders)} />
        <StatCard icon={Calendar} label="Scheduled" value={formatNumber(stats.total_schedules)} />
        <StatCard
          icon={Timer}
          label="Focus time"
          sub={
            stats.total_focus_sessions > 0 ? `${stats.total_focus_sessions} sessions` : undefined
          }
          value={formatMinutes(stats.total_focus_minutes)}
        />
      </div>

      {/* Tenure */}
      {stats.first_page_date && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <div className="text-xs text-muted-foreground">
            Oldest page:{" "}
            <span className="font-medium text-foreground">{formatDate(stats.first_page_date)}</span>
            {memberDays > 0 && <span className="ml-1">({memberDays} days ago)</span>}
          </div>
        </div>
      )}

      {/* Weekly activity */}
      {stats.weekly_activity.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <BarChart3 className="h-3.5 w-3.5" />
            Last 12 weeks
          </div>
          <ActivityChart weeks={stats.weekly_activity} />
        </div>
      )}

      {/* Feature adoption */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Layers className="h-3.5 w-3.5" />
          Features used
        </div>
        <div className="flex flex-wrap gap-2">
          <FeatureBadge active={stats.total_words > 0} icon={BookOpen} label="Notes" />
          <FeatureBadge active={stats.total_completed > 0} icon={CheckCircle2} label="Tasks" />
          <FeatureBadge active={stats.has_schedules} icon={Calendar} label="Scheduling" />
          <FeatureBadge active={stats.has_priorities} icon={Flag} label="Priorities" />
          <FeatureBadge active={stats.has_tags} icon={Hash} label="Tags" />
        </div>
      </div>
    </div>
  );
}
