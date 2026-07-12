import { Button, type ButtonSize, type ButtonVariant } from "@companion/design-system";

export interface NavLink {
  label: string;
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  external?: boolean;
  onClick?: () => void;
}

/** Row of link-wrapped design-system Buttons (header nav, hero CTAs, section CTAs). */
export function NavButtons({ links, gap = 8 }: { links: NavLink[]; gap?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap, flexWrap: "wrap", justifyContent: "center" }}>
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
