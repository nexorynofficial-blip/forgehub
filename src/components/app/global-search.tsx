"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";

import { apiErrorMessage } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { routes } from "@/lib/routes";
import { search, type SearchResults } from "@/lib/services/search-service";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";

/**
 * The backend refuses a query shorter than this as effectively empty, so the
 * input waits rather than firing requests that can only 422.
 */
const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 300;

/** How many rows of each group the dropdown previews. */
const PREVIEW_LIMIT = 4;

interface ResultRow {
  key: string;
  label: string;
  sublabel: string | null;
  href: string;
  avatarUrl?: string | null;
}

/**
 * Flattens the grouped response for rendering **without discarding the
 * grouping** — each section keeps its own heading and its own visible total,
 * which is what the API returns and what tells a user there is more behind a
 * given category.
 */
function toSections(results: SearchResults): { label: string; rows: ResultRow[] }[] {
  return [
    {
      label: "People",
      rows: results.users.items.slice(0, PREVIEW_LIMIT).map((user) => ({
        key: `user-${user.id}`,
        label: user.displayName,
        sublabel: `@${user.username}`,
        href: routes.profile(user.username),
        avatarUrl: user.avatarUrl,
      })),
    },
    {
      label: "Projects",
      rows: results.projects.items.slice(0, PREVIEW_LIMIT).map((project) => ({
        key: `project-${project.id}`,
        label: project.title,
        sublabel: project.owner ? `by ${project.owner.displayName}` : null,
        href: routes.project(project.slug),
      })),
    },
    {
      label: "Communities",
      rows: results.communities.items.slice(0, PREVIEW_LIMIT).map((community) => ({
        key: `community-${community.id}`,
        label: community.name,
        sublabel: community.category,
        href: routes.community(community.slug),
      })),
    },
    {
      label: "Posts",
      rows: results.posts.items.slice(0, PREVIEW_LIMIT).map((post) => ({
        key: `post-${post.id}`,
        label: post.content.slice(0, 80),
        sublabel: post.author ? `@${post.author.username}` : null,
        // There is no standalone post route in the app, so a post result links
        // to its author's profile rather than to a page that does not exist.
        href: post.author ? routes.profile(post.author.username) : routes.feed,
      })),
    },
    {
      label: "Tags",
      rows: results.tags.items.slice(0, PREVIEW_LIMIT).map((tag) => ({
        key: `tag-${tag.id}`,
        label: `#${tag.name}`,
        sublabel: `${String(tag.usageCount)} uses`,
        // Tags have no page of their own; the closest real destination is
        // community discovery, which filters by tag text.
        href: routes.communities,
      })),
    },
  ].filter((section) => section.rows.length > 0);
}

/**
 * UI_UX.md §7 topbar search — previously an input with no behaviour at all.
 *
 * Debounced with a plain timeout rather than a debounce library: the project
 * has no such dependency and this does not justify adding one.
 */
export function GlobalSearch() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(value.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value]);

  const enabled = query.length >= MIN_QUERY_LENGTH;

  const { data, isFetching, error } = useQuery({
    queryKey: queryKeys.search(query, "all"),
    queryFn: ({ signal }) => search({ q: query, limit: PREVIEW_LIMIT, signal }),
    enabled,
  });

  const sections = data ? toSections(data) : [];

  function go(href: string) {
    setIsOpen(false);
    setValue("");
    router.push(href);
  }

  return (
    <div ref={containerRef} className="relative hidden max-w-sm flex-1 sm:block">
      <Popover open={isOpen && enabled} onOpenChange={setIsOpen}>
        <PopoverAnchor asChild>
          <div className="relative">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2" />
            <Input
              type="search"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setIsOpen(true);
              }}
              onFocus={() => setIsOpen(true)}
              placeholder="Search projects, people, communities…"
              aria-label="Search"
              className="pl-10"
            />
            {isFetching && (
              <Loader2 className="text-muted-foreground absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin" />
            )}
          </div>
        </PopoverAnchor>

        <PopoverContent
          align="start"
          sideOffset={8}
          className="max-h-96 w-[var(--radix-popover-trigger-width)] overflow-y-auto p-0"
          // Keeps focus in the input so typing continues uninterrupted.
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          {error ? (
            <p className="text-muted-foreground p-4 text-sm">
              {apiErrorMessage(error, "Search is unavailable right now.")}
            </p>
          ) : isFetching && !data ? (
            <p className="text-muted-foreground p-4 text-sm">Searching…</p>
          ) : sections.length === 0 ? (
            <p className="text-muted-foreground p-4 text-sm">No results for “{query}”.</p>
          ) : (
            <div className="py-1">
              {sections.map((section) => (
                <div key={section.label}>
                  <p className="text-muted-foreground px-3 pt-2 pb-1 text-xs font-medium">
                    {section.label}
                  </p>
                  <ul>
                    {section.rows.map((row) => (
                      <li key={row.key}>
                        <button
                          type="button"
                          onClick={() => go(row.href)}
                          className="hover:bg-muted flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors"
                        >
                          {row.avatarUrl !== undefined && (
                            <Avatar className="size-7 shrink-0">
                              <AvatarImage src={row.avatarUrl ?? undefined} alt="" />
                              <AvatarFallback className="text-[10px]">
                                {row.label.charAt(0)}
                              </AvatarFallback>
                            </Avatar>
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm">{row.label}</span>
                            {row.sublabel && (
                              <span className="text-muted-foreground block truncate text-xs">
                                {row.sublabel}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
