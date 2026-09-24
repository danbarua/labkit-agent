import {
  ArrowRight,
  CircleCheck,
  ExternalLink,
  GitFork,
  Settings,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";

import logoMono from "../../brand/logo-mono.svg";
import logoColor from "../../brand/logo.svg";
import markUrl from "../../brand/mark.svg";
import { Button } from "../ui/button.tsx";
import { Logo } from "./logo.tsx";
import { ForkBranch, GraduatedTicks, NodeEdgeGraph, PolicyLayers } from "./motifs.tsx";
import { StatusBadge } from "./status-badge.tsx";
import { StepIndicator } from "./step-indicator.tsx";

const SWATCHES = [
  { name: "Deep Ink", hex: "#0B1220", className: "bg-ink" },
  { name: "Slate Indigo", hex: "#1E2A44", className: "bg-indigo" },
  { name: "Lab Teal", hex: "#14B8A6", className: "bg-teal" },
  { name: "Discovery Amber", hex: "#F59E0B", className: "bg-amber" },
  { name: "Paper", hex: "#F8FAFC", className: "border border-border bg-paper" },
  { name: "Cool Gray", hex: "#94A3B8", className: "bg-cool" },
] as const;

function SectionHeading({ index, title }: { index: string; title: string }) {
  return (
    <div className="flex items-center gap-4">
      <h2 className="shrink-0 text-[11px] font-semibold tracking-[0.22em] text-ink uppercase">
        {index}. {title}
      </h2>
      <div className="h-px flex-1 bg-ink/15" />
    </div>
  );
}

function Caption({ children }: { children: string }) {
  return (
    <p className="text-center text-[10px] font-medium tracking-[0.18em] text-muted-foreground uppercase">
      {children}
    </p>
  );
}

function Specimen({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure className="grid justify-items-center gap-5">
      <div className="flex h-20 items-center">{children}</div>
      <figcaption>
        <Caption>{label}</Caption>
      </figcaption>
    </figure>
  );
}

export function DesignBoard() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-16 px-6 py-10 sm:px-10 sm:py-14">
      <header className="flex items-center justify-between gap-6">
        <p className="text-[11px] font-semibold tracking-[0.22em] text-ink uppercase">
          Brand design language board
        </p>
        <Logo size="sm" />
      </header>

      <section className="grid gap-8">
        <SectionHeading index="1" title="Logo lockups" />
        <div className="grid items-end gap-10 sm:grid-cols-3">
          <Specimen label="Horizontal (flask + wordmark)">
            <img src={logoColor} alt="Labkit Agent" className="h-16 w-auto" />
          </Specimen>
          <Specimen label="Icon-only">
            <img src={markUrl} alt="" className="h-16 w-auto" />
          </Specimen>
          <Specimen label="Monochrome">
            <img src={logoMono} alt="Labkit Agent, monochrome" className="h-16 w-auto" />
          </Specimen>
        </div>
      </section>

      <section className="grid gap-8">
        <SectionHeading index="2" title="Color palette" />
        <ul className="grid grid-cols-2 gap-x-5 gap-y-6 sm:grid-cols-3 lg:grid-cols-6">
          {SWATCHES.map((swatch) => (
            <li key={swatch.hex} className="grid gap-2">
              <div className={`h-16 w-full ${swatch.className}`} />
              <div>
                <p className="text-sm font-medium text-ink">{swatch.name}</p>
                <p className="font-mono text-xs text-cool">{swatch.hex}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="grid gap-8">
        <SectionHeading index="3" title="Typography" />
        <div className="grid max-w-3xl gap-10">
          <div className="grid gap-3">
            <p className="font-wordmark text-6xl font-bold tracking-[-0.04em] text-ink sm:text-7xl">
              Labkit
            </p>
            <p className="text-[11px] font-semibold tracking-[0.18em] text-ink uppercase">
              Geometric sans (wordmark)
            </p>
            <p className="text-sm text-muted-foreground">Labkit-specific wordmark style.</p>
          </div>

          <div className="grid gap-3">
            <p className="max-w-2xl text-base leading-7 text-ink">
              Labkit Agent is an open platform for reproducible computation and knowledge
              management. It tracks code, data, and policy with transparency and provenance.
            </p>
            <p className="text-[11px] font-semibold tracking-[0.18em] text-ink uppercase">
              Body text (Inter-style)
            </p>
            <p className="text-sm text-muted-foreground">
              Highly legible. Neutral. Ideal for interfaces and documentation.
            </p>
          </div>

          <div className="grid gap-3">
            <pre className="overflow-x-auto rounded-md border border-border bg-white px-4 py-3.5 font-mono text-[13px] leading-6 text-ink">
              <span className="text-cool">{"// commit: a7f3b2e"}</span>
              {"\n"}
              {"date: 2024-05-18T10:32:00Z\n"}
              {"policy: v3 (strict)\n\n"}
              {"$ labkit status --policy,\n"}
              <span className="text-teal">✓</span>
              {" committed,\n"}
              <span className="text-teal">✓</span>
              {" policy compliant,\n"}
              <span className="text-teal">✓</span>
              {" provenance verified."}
            </pre>
            <p className="text-[11px] font-semibold tracking-[0.18em] text-ink uppercase">
              Monospace (code / journal)
            </p>
            <p className="text-sm text-muted-foreground">Mono monospace. Journaling and code.</p>
          </div>
        </div>
      </section>

      <section className="grid gap-8">
        <SectionHeading index="4" title="Motifs" />
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <Specimen label="Node-edge graph">
            <NodeEdgeGraph className="h-16" />
          </Specimen>
          <Specimen label="Graduated ticks">
            <GraduatedTicks className="h-8" />
          </Specimen>
          <Specimen label="Fork / branch">
            <ForkBranch className="h-10" />
          </Specimen>
          <Specimen label="Policy layers">
            <PolicyLayers className="h-10" />
          </Specimen>
        </div>
      </section>

      <section className="grid gap-8">
        <SectionHeading index="5" title="UI chrome" />
        <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
          <div className="grid gap-5">
            <div className="flex flex-wrap items-center gap-3">
              <Button>
                Run Analysis
                <ArrowRight />
              </Button>
              <Button variant="outline">
                View Provenance
                <ExternalLink />
              </Button>
              <Button variant="ghost">
                <Settings />
                Settings
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <StatusBadge tone="committed">
                <CircleCheck />
                committed
              </StatusBadge>
              <StatusBadge tone="fork">
                <GitFork />
                fork
              </StatusBadge>
              <StatusBadge tone="policy">
                <ShieldCheck />
                policy v3
              </StatusBadge>
            </div>
          </div>
          <StepIndicator step={3} total={5} />
        </div>
      </section>
    </main>
  );
}
