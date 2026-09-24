import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "../../lib/utils.ts";

const statusBadgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-medium leading-none [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        committed: "border-teal bg-white text-teal",
        fork: "border-amber bg-white text-amber",
        policy: "border-transparent bg-teal text-paper",
        neutral: "border-border bg-white text-ink",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  },
);

export function StatusBadge({
  className,
  tone,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof statusBadgeVariants>) {
  return <span className={cn(statusBadgeVariants({ tone }), className)} {...props} />;
}
