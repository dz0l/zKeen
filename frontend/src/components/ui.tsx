import type { ReactNode, ButtonHTMLAttributes } from "react";
import { useT } from "../lib/i18n";

interface CardProps {
  children: ReactNode;
  className?: string;
  glow?: boolean;
}

export function Card({ children, className = "", glow }: CardProps) {
  return (
    <div
      className={`rounded-2xl border border-zk-border-soft bg-zk-surface/80 backdrop-blur-sm ${
        glow ? "shadow-[0_0_40px_-12px_var(--color-zk-accent-glow)]" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-zk-border-soft px-4 py-3.5 sm:px-5">
      <div>
        <h3 className="text-[15px] font-semibold tracking-tight text-zk-text">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-zk-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Badge({
  children,
  variant = "default",
  className = "",
}: {
  children: ReactNode;
  variant?: "default" | "safe" | "expert" | "success" | "warn" | "muted";
  className?: string;
}) {
  const styles = {
    default: "bg-zk-accent/10 text-zk-accent border-zk-accent/20",
    safe: "bg-zk-safe/10 text-zk-safe border-zk-safe/25",
    expert: "bg-zk-expert/10 text-zk-expert border-zk-expert/25",
    success: "bg-zk-accent/10 text-zk-accent border-zk-accent/20",
    warn: "bg-zk-coral/10 text-zk-coral border-zk-coral/25",
    muted: "bg-zk-bg-elevated text-zk-muted border-zk-border-soft",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${styles[variant]} ${className}`}>
      {children}
    </span>
  );
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
}) {
  const variants = {
    primary: "bg-zk-accent text-zk-bg font-semibold hover:brightness-110 active:scale-[0.98]",
    secondary: "bg-zk-surface-hover border border-zk-border text-zk-text hover:border-zk-muted",
    ghost: "text-zk-muted hover:text-zk-text hover:bg-zk-surface-hover",
    danger: "bg-zk-coral/15 text-zk-coral border border-zk-coral/30 hover:bg-zk-coral/25",
  };
  const sizes = {
    sm: "px-3 py-1.5 text-xs rounded-lg",
    md: "px-4 py-2.5 text-sm rounded-xl",
    lg: "px-5 py-3 text-sm rounded-xl",
  };
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 transition-all duration-150 disabled:opacity-40 disabled:pointer-events-none ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function ModeToggle({ mode, onChange }: { mode: "safe" | "expert"; onChange: (m: "safe" | "expert") => void }) {
  return (
    <div className="flex rounded-xl bg-zk-bg-elevated p-1 border border-zk-border-soft">
      <button
        type="button"
        onClick={() => onChange("safe")}
        className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
          mode === "safe"
            ? "bg-zk-safe/20 text-zk-safe shadow-sm"
            : "text-zk-muted hover:text-zk-text"
        }`}
      >
        Safe
      </button>
      <button
        type="button"
        onClick={() => onChange("expert")}
        className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
          mode === "expert"
            ? "bg-zk-expert/20 text-zk-expert shadow-sm"
            : "text-zk-muted hover:text-zk-text"
        }`}
      >
        Expert
      </button>
    </div>
  );
}

export function MockBanner() {
  const t = useT();
  return (
    <div className="mx-4 mb-3 rounded-xl border border-zk-violet/25 bg-zk-violet/8 px-3 py-2 text-center text-[11px] text-zk-violet sm:mx-0">
      {t("mock.banner")}
    </div>
  );
}

export function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-zk-border-soft bg-zk-bg-elevated/60 px-3 py-2.5">
      <p className="text-[10px] font-medium uppercase tracking-wider text-zk-dim">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-zk-text">{value}</p>
      {hint && <p className="mt-0.5 text-[10px] text-zk-muted">{hint}</p>}
    </div>
  );
}

export function Input({
  label,
  placeholder,
  value,
  onChange,
  hint,
  mono,
  type = "text",
}: {
  label: string;
  placeholder?: string;
  value?: string;
  onChange?: (v: string) => void;
  hint?: string;
  mono?: boolean;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-zk-muted">{label}</span>
      <input
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        className={`w-full rounded-xl border border-zk-border-soft bg-zk-bg-elevated px-3.5 py-2.5 text-sm text-zk-text outline-none transition-colors placeholder:text-zk-dim focus:border-zk-accent/50 focus:ring-2 focus:ring-zk-accent/10 ${
          mono ? "font-mono" : ""
        }`}
      />
      {hint && <span className="mt-1 block text-[10px] text-zk-dim">{hint}</span>}
    </label>
  );
}

export function Select({
  label,
  options,
  value,
  onChange,
  inline = false,
  className = "",
  compact = false,
}: {
  label: string;
  options: { value: string; label: string }[];
  value?: string;
  onChange?: (v: string) => void;
  /** Label and select on one row. */
  inline?: boolean;
  className?: string;
  /** Smaller label/control for dense forms. */
  compact?: boolean;
}) {
  return (
    <label className={`block ${inline ? "flex min-w-0 items-center gap-3" : ""} ${className}`}>
      <span
        className={`shrink-0 font-medium text-zk-muted ${compact ? "text-[10px]" : "text-xs"} ${inline ? "whitespace-nowrap" : "mb-1.5 block"}`}
      >
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        className={`${inline ? "min-w-0 flex-1" : "w-full"} appearance-none rounded-xl border border-zk-border-soft bg-zk-bg-elevated text-zk-text outline-none focus:border-zk-accent/50 ${
          compact ? "px-2 py-1.5 text-[11px]" : "px-3.5 py-2 text-sm"
        }`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
