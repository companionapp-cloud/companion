import { Button, type ButtonSize, type ButtonVariant } from "../ds";

export interface NavLink {
  label: string;
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  external?: boolean;
  onClick?: () => void;
}

/** Row of link-wrapped design-system Buttons (header nav, hero CTAs, section CTAs). Centered
 *  by default; `align="start"` for rows that sit in left-aligned card copy. */
export function NavButtons({
  links,
  gap = 8,
  align = "center",
}: {
  links: NavLink[];
  gap?: number;
  align?: "center" | "start";
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap,
        flexWrap: "wrap",
        justifyContent: align === "start" ? "flex-start" : "center",
      }}
    >
      {links.map((link) => (
        <a
          key={link.label}
          href={link.href}
          style={{ textDecoration: "none" }}
          onClick={link.onClick}
          {...(link.external ? { target: "_blank", rel: "noreferrer" } : {})}
        >
          <Button variant={link.variant ?? "ghost"} size={link.size ?? "sm"} label={link.label} />
        </a>
      ))}
    </div>
  );
}
