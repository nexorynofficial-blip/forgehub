import type { Metadata } from "next";

import { NewProjectForm } from "@/components/project/new-project-form";
import { FadeIn } from "@/components/motion/fade-in";

export const metadata: Metadata = { title: "New project" };

/**
 * Where the sidebar and mobile nav have always pointed.
 *
 * The segment is static, so it takes precedence over the sibling
 * `[projectId]` route — before this page existed, `/projects/new` fell through
 * to that dynamic segment and rendered "project not found" for a slug of
 * literally `new`.
 */
export default function NewProjectPage() {
  return (
    <div className="mx-auto max-w-2xl pt-8 pb-8">
      <FadeIn>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          New project
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          A title is all you need to start. Everything else can follow.
        </p>
      </FadeIn>
      <FadeIn delay={0.05} className="mt-6">
        <NewProjectForm />
      </FadeIn>
    </div>
  );
}
