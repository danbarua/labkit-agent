import type { SVGProps } from "react";

import { cn } from "../../lib/utils.ts";

type MotifProps = SVGProps<SVGSVGElement>;

export function NodeEdgeGraph({ className, ...props }: MotifProps) {
  return (
    <svg
      viewBox="0 0 132 76"
      fill="none"
      aria-hidden="true"
      className={cn("h-16 w-auto text-ink", className)}
      {...props}
    >
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M24 16 24 58" />
        <path d="M24 16 66 38" />
        <path d="M24 58 66 38" />
        <path d="M66 38 110 16" />
        <path d="M66 38 108 60" />
        <path d="M110 16 108 60" />
      </g>
      <g className="fill-ink">
        <circle cx="24" cy="16" r="4.5" />
        <circle cx="24" cy="58" r="4.5" />
        <circle cx="110" cy="16" r="4.5" />
        <circle cx="108" cy="60" r="4.5" />
      </g>
      <circle cx="66" cy="38" r="5.5" className="fill-teal" />
    </svg>
  );
}

const TICKS = [
  { id: "a", height: 7 },
  { id: "b", height: 12 },
  { id: "c", height: 7 },
  { id: "d", height: 7 },
  { id: "e", height: 20 },
  { id: "f", height: 7 },
  { id: "g", height: 12 },
  { id: "h", height: 7 },
  { id: "i", height: 7 },
  { id: "j", height: 20 },
  { id: "k", height: 7 },
  { id: "l", height: 12 },
  { id: "m", height: 7 },
  { id: "n", height: 7 },
  { id: "o", height: 16 },
  { id: "p", height: 7 },
];

export function GraduatedTicks({ className, ...props }: MotifProps) {
  return (
    <svg
      viewBox="0 0 156 28"
      fill="none"
      aria-hidden="true"
      className={cn("h-7 w-auto text-ink", className)}
      {...props}
    >
      {TICKS.map((tick, index) => (
        <rect
          key={tick.id}
          x={2 + index * 9.6}
          y={26 - tick.height}
          width="1.6"
          height={tick.height}
          className="fill-current"
        />
      ))}
    </svg>
  );
}

export function ForkBranch({ className, ...props }: MotifProps) {
  return (
    <svg
      viewBox="0 0 148 44"
      fill="none"
      aria-hidden="true"
      className={cn("h-9 w-auto text-ink", className)}
      {...props}
    >
      <path
        d="M2 22H58M58 22c12 0 14-2 18-10h64M58 22c12 0 14 2 18 10h64"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PolicyLayers({ className, ...props }: MotifProps) {
  return (
    <svg
      viewBox="0 0 148 46"
      fill="none"
      aria-hidden="true"
      className={cn("h-10 w-auto", className)}
      {...props}
    >
      <line x1="2" x2="146" y1="4" y2="4" stroke="#0B1220" strokeWidth="2" strokeLinecap="round" />
      <line
        x1="2"
        x2="146"
        y1="16"
        y2="16"
        stroke="#14B8A6"
        strokeWidth="1.7"
        strokeDasharray="8 5"
        strokeLinecap="round"
      />
      <line
        x1="2"
        x2="146"
        y1="28"
        y2="28"
        stroke="#14B8A6"
        strokeWidth="1.7"
        strokeDasharray="8 5"
        strokeLinecap="round"
        opacity="0.45"
      />
      <line
        x1="2"
        x2="146"
        y1="40"
        y2="40"
        stroke="#94A3B8"
        strokeWidth="1.7"
        strokeDasharray="8 5"
        strokeLinecap="round"
      />
    </svg>
  );
}
