"use client";

import { Copy } from "lucide-react";

import { useToast } from "@/hooks/use-toast";
import type { CodeSnippet } from "@/types";
import { Button } from "@/components/ui/button";

export function CodeBlock({ snippet }: { snippet: CodeSnippet }) {
  const toast = useToast((state) => state.toast);

  async function handleCopy() {
    await navigator.clipboard.writeText(snippet.code);
    toast({ title: "Copied", description: "Code copied to clipboard." });
  }

  return (
    <div className="border-border bg-background mt-3 overflow-hidden rounded-md border">
      <div className="border-border bg-surface flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-muted-foreground text-xs">{snippet.language}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          className="h-7 px-2 text-xs"
        >
          <Copy className="size-3.5" />
          Copy
        </Button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
        <code>{snippet.code}</code>
      </pre>
    </div>
  );
}
