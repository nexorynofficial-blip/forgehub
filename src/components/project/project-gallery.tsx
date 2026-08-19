"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight, ImageIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";

/** UI_UX.md §9 "Gallery". Every `gallery` entry is an opaque id, not a real
 * URL — same placeholder-tile convention as the Feed's image posts, see
 * docs/ASSUMPTIONS.md. */
export function ProjectGallery({ gallery }: { gallery: string[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (gallery.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Gallery</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {gallery.map((item, index) => (
            <button
              key={item}
              type="button"
              onClick={() => setOpenIndex(index)}
              aria-label={`Open image ${index + 1}`}
              className="bg-muted hover:bg-muted/70 focus-visible:ring-ring flex aspect-video items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              <ImageIcon className="text-muted-foreground size-6" />
            </button>
          ))}
        </div>
      </CardContent>

      <Dialog
        open={openIndex !== null}
        onOpenChange={(open) => !open && setOpenIndex(null)}
      >
        <DialogContent className="max-w-2xl">
          {openIndex !== null && (
            <div className="flex flex-col items-center gap-4">
              <div className="bg-muted flex aspect-video w-full items-center justify-center rounded-md">
                <ImageIcon className="text-muted-foreground size-10" />
              </div>
              <div className="flex items-center gap-4">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    setOpenIndex((i) => (i! > 0 ? i! - 1 : gallery.length - 1))
                  }
                  aria-label="Previous image"
                >
                  <ChevronLeft />
                </Button>
                <span className="text-muted-foreground text-sm">
                  {openIndex + 1} / {gallery.length}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    setOpenIndex((i) => (i! < gallery.length - 1 ? i! + 1 : 0))
                  }
                  aria-label="Next image"
                >
                  <ChevronRight />
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
