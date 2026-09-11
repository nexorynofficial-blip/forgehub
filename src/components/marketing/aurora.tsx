import { cn } from "@/lib/utils";

/**
 * The violet bloom the dark canvas sits in.
 *
 * Three heavily blurred blobs at different scales and drift speeds, layered
 * under a grain overlay. The point is depth without detail: the previous hero
 * put a wireframe network behind the headline, and its hard lines crossed the
 * type at exactly the size the eye reads — busy where it should have been
 * quiet. Light has no edges to compete with.
 *
 * Blobs are positioned off-centre and asymmetrically on purpose. A symmetric
 * glow behind centred text reads as a vignette effect; an off-centre one reads
 * as a light source somewhere in the room.
 *
 * Purely decorative — `aria-hidden`, pointer-transparent, and it animates only
 * where the viewer allows motion (the reduced-motion rule in `globals.css`
 * collapses the drift for everyone else).
 */
export function Aurora({
  className,
  intensity = "full",
}: {
  className?: string;
  /** `subtle` is for surfaces that sit behind real content, like the app shell. */
  intensity?: "full" | "subtle";
}) {
  const subtle = intensity === "subtle";

  return (
    <div
      aria-hidden="true"
      className={cn(
        "grain vignette pointer-events-none absolute inset-0 overflow-hidden",
        className,
      )}
    >
      {/* The primary source: a dense violet cloud, upper left. Tighter and
          more opaque than a soft wash — the light has to fall off inside the
          frame, or the whole canvas lifts to an even lavender and the blacks
          stop being black. */}
      <div
        className={cn(
          "animate-drift absolute rounded-full blur-[110px]",
          "-top-[28%] -left-[12%] size-[38rem]",
          subtle ? "bg-primary/14" : "bg-primary/45",
        )}
      />
      {/* A second violet mass, mid-right and dimmer, so the field has a
          direction across the frame rather than one centred halo. Kept in the
          same hue: a cyan counterweight here read as a stock two-stop
          gradient, which is the look this redesign is moving away from. */}
      <div
        className={cn(
          "animate-drift-slow absolute rounded-full blur-[140px]",
          "top-[22%] -right-[18%] size-[32rem]",
          subtle ? "bg-primary/8" : "bg-primary/22",
        )}
      />
      {/* One cool note, low and small. Enough for the palette's cyan to exist
          on the page at all without steering it. */}
      <div
        className={cn(
          "animate-drift absolute rounded-full blur-[130px]",
          "bottom-[-20%] left-[42%] size-[26rem]",
          subtle ? "bg-secondary/5" : "bg-secondary/10",
        )}
      />
    </div>
  );
}
