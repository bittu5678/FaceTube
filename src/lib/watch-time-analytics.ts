import type {
  WatchTimeAnalyticsHistoryPoint,
  WatchTimeAnalyticsResponse,
} from "./api";

export type WatchTimePeriod = "7D" | "28D" | "30D" | "90D" | "12M";

export interface WatchTimeDashboardViewState {
  hasData: boolean;
  totalWatchedSeconds: number;
  totalHours: number;
  hoursLabel: string;
  growthPercent: number | null;
  growthLabel: string;
  growthDirection: "positive" | "negative" | "neutral";
  avgViewDurationSeconds: number;
  avgViewDurationLabel: string;
  history: WatchTimeAnalyticsHistoryPoint[];
}

export function formatWatchDurationCompact(secondsInput: number): string {
  const sec = Math.max(0, Math.floor(Number.isFinite(secondsInput) ? secondsInput : 0));
  const hours = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const remSec = sec % 60;
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m ${remSec}s`;
}

export function formatWatchTimeHours(totalWatchedSecondsInput: number): string {
  const sec = Math.max(0, Math.floor(Number.isFinite(totalWatchedSecondsInput) ? totalWatchedSecondsInput : 0));
  if (sec === 0) {
    return "0 hrs";
  }

  const rawHours = sec / 3600;
  const roundedTwo = Number(rawHours.toFixed(2));
  if (roundedTwo <= 0) {
    return "< 0.01 hrs";
  }

  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(roundedTwo);
  return `${formatted} hrs`;
}

export function formatWatchGrowthBadge(growthPercent: number | null | undefined): {
  label: string;
  direction: "positive" | "negative" | "neutral";
} {
  if (growthPercent === null || growthPercent === undefined || !Number.isFinite(growthPercent)) {
    return {
      label: "No prior baseline",
      direction: "neutral",
    };
  }

  const rounded = Number(growthPercent.toFixed(1));
  if (rounded > 0) {
    return {
      label: `+${rounded}%`,
      direction: "positive",
    };
  }
  if (rounded < 0) {
    return {
      label: `${rounded}%`,
      direction: "negative",
    };
  }
  return {
    label: "0%",
    direction: "neutral",
  };
}

export function buildWatchTimeDashboardViewState(
  analytics: WatchTimeAnalyticsResponse | null | undefined,
): WatchTimeDashboardViewState {
  if (!analytics || !analytics.summary) {
    return {
      hasData: false,
      totalWatchedSeconds: 0,
      totalHours: 0,
      hoursLabel: "0 hrs",
      growthPercent: null,
      growthLabel: "No prior baseline",
      growthDirection: "neutral",
      avgViewDurationSeconds: 0,
      avgViewDurationLabel: "No data yet",
      history: [],
    };
  }

  const totalWatchedSeconds = Math.max(
    0,
    Math.floor(Number(analytics.summary.total_watched_seconds) || 0),
  );
  const hasRealPeriodData = Boolean(analytics.has_data) && totalWatchedSeconds > 0;

  const growthPercent =
    analytics.summary.growth_percent === null || analytics.summary.growth_percent === undefined
      ? null
      : Number(analytics.summary.growth_percent);
  const growth = formatWatchGrowthBadge(growthPercent);

  if (!hasRealPeriodData) {
    return {
      hasData: false,
      totalWatchedSeconds: 0,
      totalHours: 0,
      hoursLabel: "0 hrs",
      growthPercent,
      growthLabel: growth.label,
      growthDirection: growth.direction,
      avgViewDurationSeconds: 0,
      avgViewDurationLabel: "No data yet",
      history: [],
    };
  }

  const avgViewDurationSeconds = Math.max(
    0,
    Math.floor(Number(analytics.summary.avg_view_duration_seconds) || 0),
  );
  const qualifiedSessions = Math.max(
    0,
    Math.floor(Number(analytics.summary.qualified_sessions) || 0),
  );

  const avgViewDurationLabel =
    qualifiedSessions > 0
      ? analytics.summary.avg_view_duration_formatted?.trim() ||
        formatWatchDurationCompact(avgViewDurationSeconds)
      : "0m 0s";

  const history = Array.isArray(analytics.history)
    ? analytics.history.map((point) => {
        const watchedSeconds = Math.max(0, Math.floor(Number(point.watched_seconds) || 0));
        return {
          ...point,
          watched_seconds: watchedSeconds,
          hours:
            Number.isFinite(Number(point.hours)) && Number(point.hours) >= 0
              ? Number(point.hours)
              : Number((watchedSeconds / 3600).toFixed(2)),
          qualified_watched_seconds: Math.max(
            0,
            Math.floor(Number(point.qualified_watched_seconds) || 0),
          ),
          qualified_sessions: Math.max(0, Math.floor(Number(point.qualified_sessions) || 0)),
        };
      })
    : [];

  return {
    hasData: true,
    totalWatchedSeconds,
    totalHours: Number((totalWatchedSeconds / 3600).toFixed(2)),
    hoursLabel: formatWatchTimeHours(totalWatchedSeconds),
    growthPercent,
    growthLabel: growth.label,
    growthDirection: growth.direction,
    avgViewDurationSeconds,
    avgViewDurationLabel,
    history,
  };
}
