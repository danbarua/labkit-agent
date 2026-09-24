import { cn } from "../../lib/utils.ts";

const SLOTS = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;

export function StepIndicator({
  step,
  total = 5,
  className,
}: {
  step: number;
  total?: number;
  className?: string;
}) {
  const count = Math.min(Math.max(total, 1), SLOTS.length);
  const current = Math.min(Math.max(step, 0), count);
  const slots = SLOTS.slice(0, count);

  return (
    <div className={cn("grid w-44 gap-2", className)}>
      <p className="text-right text-xs text-muted-foreground">
        Step {current} of {count}
      </p>
      <div className="flex gap-1" role="img" aria-label={`Step ${current} of ${count}`}>
        {slots.map((slot) => (
          <span
            key={slot}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              Number(slot) <= current ? "bg-teal" : "bg-cool",
            )}
          />
        ))}
      </div>
    </div>
  );
}
