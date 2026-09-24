import type { SVGProps } from "react";

import { cn } from "../../lib/utils.ts";

const OUTLINE =
  "M23.2 6h17.6v4.4h-2.8V20.2L52.4 55.4A7.4 7.4 0 0 1 45.4 66H18.6A7.4 7.4 0 0 1 11.6 55.4L26 20.2V10.4h-2.8V6Z";

export function Mark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 64 72"
      fill="none"
      aria-hidden
      className={cn("aspect-[8/9] h-12 w-auto shrink-0 text-teal", className)}
      {...props}
    >
      <path
        d={OUTLINE}
        stroke="currentColor"
        strokeWidth="3.25"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path d="M15.36 46.2H19.61" stroke="currentColor" strokeWidth="2.35" strokeLinecap="round" />
      <circle cx="22.96" cy="46.2" r="3.35" fill="currentColor" />
      <path
        d="M25.53 44.05 32.51 38.24"
        stroke="currentColor"
        strokeWidth="2.35"
        strokeLinecap="round"
      />
      <circle cx="36.16" cy="35.2" r="2.7" fill="none" stroke="currentColor" strokeWidth="2.35" />
      <circle cx="36.16" cy="56.8" r="2.7" fill="none" stroke="currentColor" strokeWidth="2.35" />
    </svg>
  );
}
