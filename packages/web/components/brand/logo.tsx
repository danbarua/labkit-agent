import type { HTMLAttributes } from "react";

import { cn } from "../../lib/utils.ts";
import { Mark } from "./mark.tsx";

const sizes = {
  sm: { mark: "h-8", word: "text-[1.35rem]", gap: "gap-2.5" },
  md: { mark: "h-14", word: "text-[2.55rem]", gap: "gap-4" },
} as const;

export function Logo({
  variant = "color",
  lockup = "horizontal",
  size = "md",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  variant?: "color" | "mono";
  lockup?: "horizontal" | "icon";
  size?: keyof typeof sizes;
}) {
  const ink = variant === "mono";
  const scale = sizes[size];
  const markClass = cn(scale.mark, ink && "text-ink");

  if (lockup === "icon") {
    return (
      <span className={cn("inline-flex", className)} {...props}>
        <Mark role="img" aria-label="Labkit Agent" aria-hidden={false} className={markClass} />
      </span>
    );
  }

  return (
    <span className={cn("inline-flex items-center", scale.gap, className)} {...props}>
      <Mark className={markClass} />
      <span
        className={cn(
          "font-wordmark font-bold leading-none tracking-[-0.03em] text-ink",
          scale.word,
        )}
      >
        Labkit Agent
      </span>
    </span>
  );
}
