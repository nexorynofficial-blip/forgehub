import { MessagesSquare } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/**
 * **Deferred — no backend endpoint exists.**
 *
 * Comments exist on *posts* (`/posts/{id}/comments`), not on projects: there
 * is no project-comment table in the schema and no route anywhere in the
 * backend's 133 operations. Routing this at the post comment API would attach
 * project feedback to an unrelated entity, so the section keeps its place in
 * the page and says plainly that it is not live yet.
 *
 * The composer stays visible but inert. Removing it would silently change the
 * page's shape; leaving it *working* would accept text that goes nowhere and
 * disappears on reload, which is the fake-success this phase exists to remove.
 */
export function ProjectDiscussion() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Discussion</CardTitle>
        <CardDescription>Project discussions aren&apos;t available yet.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <span className="bg-muted text-muted-foreground flex size-11 items-center justify-center rounded-full">
            <MessagesSquare className="size-5" />
          </span>
          <p className="text-muted-foreground max-w-sm text-sm">
            Comments and feedback on projects are coming in a later release.
          </p>
        </div>

        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(event) => event.preventDefault()}
        >
          <Input
            placeholder="Discussions are not open yet"
            aria-label="Write a comment"
            disabled
          />
          <Button type="submit" size="sm" variant="secondary" disabled>
            Post
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
