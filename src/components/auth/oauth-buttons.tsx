"use client";

import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { GitHubIcon, GoogleIcon } from "@/components/auth/oauth-icons";

/** PRD.md §4.1 lists Google/GitHub OAuth. Frontend-only phase — clicking
 * surfaces that clearly rather than pretending to authenticate. */
export function OAuthButtons() {
  const toast = useToast((state) => state.toast);

  function handleClick(provider: string) {
    toast({
      title: `${provider} sign-in`,
      description: "OAuth isn't wired up yet — this phase is frontend UI only.",
    });
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      <Button type="button" variant="secondary" onClick={() => handleClick("Google")}>
        <GoogleIcon className="size-4" />
        Google
      </Button>
      <Button type="button" variant="secondary" onClick={() => handleClick("GitHub")}>
        <GitHubIcon className="size-4" />
        GitHub
      </Button>
    </div>
  );
}
