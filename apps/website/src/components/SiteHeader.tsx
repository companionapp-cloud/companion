import { BrandMark } from "@companion/design-system";
import { NavButtons, type NavLink } from "./NavButtons";

interface Props {
  links: NavLink[];
  /** Landing page header floats on the hero gradient without a border. */
  border?: boolean;
  /** Docs pages keep the header pinned with a blur backdrop. */
  sticky?: boolean;
}

export function SiteHeader({ links, border = true, sticky = false }: Props) {
  const className = ["site-header", border && "site-header--border", sticky && "site-header--sticky"]
    .filter(Boolean)
    .join(" ");

  return (
    <header className={className} style={border ? undefined : { position: "relative", zIndex: 2 }}>
      <a href="/" className="wordmark">
        <BrandMark size={30} />
        <span>Companion</span>
      </a>
      <NavButtons links={links} />
    </header>
  );
}
