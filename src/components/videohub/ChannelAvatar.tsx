import { useEffect, useState } from "react";
import { resolveMediaUrl } from "@/lib/media-url";

interface ChannelAvatarProps {
  src?: string | null | undefined;
  name: string;
  initials?: string | undefined;
  sizeClassName?: string;
  imageRingClassName?: string;
  fallbackClassName?: string;
  tint?: string | undefined;
}

/**
 * Reusable circular channel avatar component.
 * Resolves relative/production media URLs safely and automatically falls back
 * to clean initials when no logo exists or if an image fails to load.
 */
export function ChannelAvatar({
  src,
  name,
  initials,
  sizeClassName = "h-9 w-9",
  imageRingClassName = "ring-1 ring-border shadow-sm",
  fallbackClassName = "bg-gradient-to-br from-brand to-brand-dark text-white text-xs font-bold shadow-sm",
  tint,
}: ChannelAvatarProps) {
  const resolvedSrc = resolveMediaUrl(src);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
  }, [resolvedSrc]);

  const displayInitials = (
    initials ||
    (name || "FT")
      .trim()
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2) ||
    "FT"
  ).toUpperCase();

  if (resolvedSrc && !hasError) {
    return (
      <img
        src={resolvedSrc}
        alt={name || "Channel logo"}
        onError={() => setHasError(true)}
        className={`${sizeClassName} shrink-0 rounded-full object-cover ${imageRingClassName}`}
      />
    );
  }

  return (
    <span
      className={`grid ${sizeClassName} shrink-0 place-items-center rounded-full ${fallbackClassName}`}
      style={tint ? { backgroundColor: tint } : undefined}
      aria-label={name || "Channel avatar"}
    >
      {displayInitials}
    </span>
  );
}
