"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { MessageSquare, Pencil, UserCheck, UserPlus } from "lucide-react";

import { apiErrorMessage } from "@/lib/api";
import { formatCompactNumber } from "@/lib/format";
import { queryKeys } from "@/lib/query-keys";
import { routes } from "@/lib/routes";
import { followUser, unfollowUser } from "@/lib/services/follows-service";
import { useAuth } from "@/providers/auth-provider";
import { useToast } from "@/hooks/use-toast";
import { isRestrictedProfile, type ProfileRelationship, type ProfileUser } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SocialLinkIcon } from "@/components/profile/social-link-icon";

/** UI_UX.md §8 "Animated Banner" + profile header (avatar, bio, skills,
 * social links, stats, follow/edit actions). */
export function ProfileBanner({
  user,
  relationship,
}: {
  user: ProfileUser;
  relationship: ProfileRelationship | null;
}) {
  const toast = useToast((state) => state.toast);
  const queryClient = useQueryClient();
  // Identity comes from the session rather than a `currentUser` query: the
  // banner only renders behind `RequireAuth`, so the viewer is already known.
  const { user: sessionUser } = useAuth();
  const isOwnProfile = relationship?.isSelf ?? sessionUser?.id === user.id;

  // Server truth, held locally only so the button can react before the
  // profile query is refetched. `followersCount` comes back on the response.
  const [isFollowing, setIsFollowing] = useState(relationship?.isFollowing ?? false);
  const [followersCount, setFollowersCount] = useState(user.followersCount);
  const [pulseKey, setPulseKey] = useState(0);

  /**
   * A followers-only profile arrives as an identity shell with no bio, skills,
   * social links, or experience — absent, not empty. Narrowing here is what
   * lets the sections below read those fields at all.
   */
  const details = isRestrictedProfile(user) ? null : user;

  const followMutation = useMutation({
    mutationFn: (next: boolean) =>
      next ? followUser(user.username) : unfollowUser(user.username),
    onSuccess: (result) => {
      // Trust the server's answer, not the optimistic guess.
      setIsFollowing(result.following);
      setFollowersCount(result.followersCount);
      if (result.following) setPulseKey((previous) => previous + 1);
      void queryClient.invalidateQueries({ queryKey: queryKeys.profile(user.username) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.followers(user.username),
      });
      toast({
        title: result.following ? "Following" : "Unfollowed",
        description: result.following
          ? `You're now following ${user.displayName}.`
          : `You unfollowed ${user.displayName}.`,
      });
    },
    onError: (error) => {
      toast({
        variant: "danger",
        title: "That didn't work",
        description: apiErrorMessage(error, "Please try again in a moment."),
      });
    },
  });

  function handleFollowToggle() {
    // `isPending` also disables the button, so this only guards a double-fire.
    if (followMutation.isPending) return;
    followMutation.mutate(!isFollowing);
  }

  return (
    <div>
      <div className="bg-surface relative h-40 overflow-hidden rounded-lg sm:h-56">
        {user.bannerUrl ? (
          <Image src={user.bannerUrl} alt="" fill className="object-cover" />
        ) : (
          <div
            aria-hidden="true"
            className="animate-gradient-shift size-full"
            style={{
              backgroundImage:
                "radial-gradient(circle at 15% 30%, rgb(124 92 255 / 35%), transparent 55%), " +
                "radial-gradient(circle at 85% 20%, rgb(0 212 255 / 25%), transparent 50%), " +
                "radial-gradient(circle at 50% 90%, rgb(255 184 0 / 15%), transparent 45%)",
            }}
          />
        )}
      </div>

      <div className="relative px-2 sm:px-4">
        <Avatar className="border-background bg-card absolute -top-12 left-4 size-24 border-4 sm:-top-14 sm:size-28">
          <AvatarImage src={user.avatarUrl ?? undefined} alt="" />
          <AvatarFallback className="text-2xl">
            {user.displayName.charAt(0)}
          </AvatarFallback>
        </Avatar>

        <div className="flex justify-end gap-3 pt-4">
          {isOwnProfile ? (
            <Button variant="secondary" asChild>
              <Link href={routes.settings.account}>
                <Pencil />
                Edit profile
              </Link>
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                size="icon"
                aria-label={`Message ${user.displayName}`}
              >
                <MessageSquare />
              </Button>
              <div className="relative">
                <AnimatePresence>
                  {pulseKey > 0 && (
                    <motion.span
                      key={pulseKey}
                      aria-hidden="true"
                      className="border-primary pointer-events-none absolute inset-0 rounded-full border-2"
                      initial={{ opacity: 0.6, scale: 1 }}
                      animate={{ opacity: 0, scale: 1.4 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.5, ease: "easeOut" }}
                    />
                  )}
                </AnimatePresence>
                <Button
                  variant={isFollowing ? "secondary" : "primary"}
                  onClick={handleFollowToggle}
                  disabled={followMutation.isPending}
                >
                  <motion.span
                    key={isFollowing ? "following" : "follow"}
                    initial={{ scale: 0.7, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: "spring", stiffness: 500, damping: 20 }}
                    className="inline-flex items-center gap-2"
                  >
                    {isFollowing ? (
                      <>
                        <UserCheck />
                        Following
                      </>
                    ) : (
                      <>
                        <UserPlus />
                        Follow
                      </>
                    )}
                  </motion.span>
                </Button>
              </div>
            </>
          )}
        </div>

        <div className="mt-8 sm:mt-2">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            {user.displayName}
          </h1>
          <p className="text-muted-foreground text-sm">
            @{user.username} · {user.builderRank}
          </p>
        </div>

        {details?.bio && (
          <p className="mt-3 max-w-2xl text-sm leading-relaxed">{details.bio}</p>
        )}

        {details && (details.skills.length > 0 || details.techStack.length > 0) && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {details.skills.map((skill) => (
              <Badge key={skill} variant="primary">
                {skill}
              </Badge>
            ))}
            {details.techStack.map((tech) => (
              <Badge key={tech} variant="outline">
                {tech}
              </Badge>
            ))}
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <span>
            <strong className="text-foreground font-semibold">
              {formatCompactNumber(followersCount)}
            </strong>{" "}
            <span className="text-muted-foreground">followers</span>
          </span>
          <span>
            <strong className="text-foreground font-semibold">
              {formatCompactNumber(user.followingCount)}
            </strong>{" "}
            <span className="text-muted-foreground">following</span>
          </span>
          <span>
            <strong className="text-foreground font-semibold">
              {user.projectsCount}
            </strong>{" "}
            <span className="text-muted-foreground">projects</span>
          </span>
          {details?.experienceYears != null && (
            <span>
              <strong className="text-foreground font-semibold">
                {details.experienceYears}y
              </strong>{" "}
              <span className="text-muted-foreground">experience</span>
            </span>
          )}
          {details && details.socialLinks.length > 0 && (
            <div className="ml-auto flex items-center gap-3">
              {details.socialLinks.map((link) => (
                <a
                  key={link.platform}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={link.platform}
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
                >
                  <SocialLinkIcon platform={link.platform} className="size-4" />
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
