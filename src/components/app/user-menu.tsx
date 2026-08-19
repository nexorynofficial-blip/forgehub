"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { LogOut, Settings, User } from "lucide-react";

import { routes } from "@/lib/routes";
import { getCurrentUser } from "@/lib/services/user-service";
import { useToast } from "@/hooks/use-toast";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";

export function UserMenu() {
  const toast = useToast((state) => state.toast);
  const { data: user, isLoading } = useQuery({
    queryKey: ["currentUser"],
    queryFn: getCurrentUser,
  });

  function handleSignOut() {
    toast({
      title: "Signed out",
      description:
        "This is a mock session — a real sign-out arrives with the auth backend.",
    });
  }

  if (isLoading || !user) {
    return <Skeleton className="size-10 rounded-full" />;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className="focus-visible:ring-ring rounded-full focus-visible:ring-2 focus-visible:outline-none"
        >
          <Avatar>
            <AvatarImage src={user.avatarUrl ?? undefined} alt="" />
            <AvatarFallback>{user.displayName.charAt(0)}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <p className="text-foreground truncate text-sm font-medium">
            {user.displayName}
          </p>
          <p className="truncate text-xs font-normal">@{user.username}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={routes.profile(user.username)}>
            <User className="size-4" />
            View profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={routes.settings.account}>
            <Settings className="size-4" />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleSignOut}>
          <LogOut className="size-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
