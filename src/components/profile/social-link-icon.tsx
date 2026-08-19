import { Globe } from "lucide-react";

import { GitHubIcon } from "@/components/auth/oauth-icons";

function XIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/** lucide-react has no brand icons (see docs/ASSUMPTIONS.md), so known
 * platforms get a hand-drawn mark and anything else falls back to a
 * generic globe — `SocialLink.platform` (types/user.ts) is a free string,
 * not an enum. */
export function SocialLinkIcon({
  platform,
  className,
}: {
  platform: string;
  className?: string;
}) {
  switch (platform.toLowerCase()) {
    case "github":
      return <GitHubIcon className={className} />;
    case "x":
    case "twitter":
      return <XIcon className={className} />;
    default:
      return <Globe className={className} />;
  }
}
