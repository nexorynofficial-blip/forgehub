import { cn } from "@/lib/utils";
import { RevealOnScroll } from "@/components/motion/reveal-on-scroll";

/**
 * The one heading block every marketing section uses.
 *
 * Before this existed each section rolled its own, and they had drifted apart:
 * some had an uppercase eyebrow and some did not, the gap under the h2 was
 * `mt-3` in one place and `mt-4` in another, and the centred/left choice was
 * made per section with no rule behind it — so measured on the page the
 * headings started at x=377, x=169 and x=169 in turn, and the eye had to
 * re-find the beginning of the text at every section boundary.
 *
 * One component means the rhythm is now identical everywhere, and the one real
 * decision — centred or left — is an explicit prop with a rule:
 *
 *   `center`  full-width sections, where the heading owns the whole row
 *   `start`   two-column sections, where it heads its own column and being
 *             centred over one column would leave it aligned to nothing
 */
interface SectionHeadingProps {
  /** Short uppercase label. Present on every section — it is what makes the
   * vertical rhythm of the page repeat rather than restart. */
  eyebrow: string;
  title: string;
  lede?: string;
  align?: "center" | "start";
  className?: string;
  /** Delay passed to the reveal, for sections that stagger their own content. */
  delay?: number;
}

export function SectionHeading({
  eyebrow,
  title,
  lede,
  align = "center",
  className,
  delay = 0,
}: SectionHeadingProps) {
  return (
    <RevealOnScroll
      blur
      delay={delay}
      className={cn(
        "max-w-2xl",
        align === "center" ? "mx-auto text-center" : "text-left",
        className,
      )}
    >
      <p className="text-primary text-xs font-semibold tracking-[0.18em] uppercase">
        {eyebrow}
      </p>
      <h2 className="font-display mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        {title}
      </h2>
      {lede ? (
        <p className="text-muted-foreground mt-4 text-lg text-balance">{lede}</p>
      ) : null}
    </RevealOnScroll>
  );
}
