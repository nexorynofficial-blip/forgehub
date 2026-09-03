import type { Metadata } from "next";

import { ProfileView } from "@/components/profile/profile-view";

interface ProfilePageProps {
  params: Promise<{ username: string }>;
}

/**
 * Titled from the handle alone.
 *
 * The display name would read better, but resolving it here would mean an
 * unauthenticated server request — the access token is browser-only — and a
 * page title is not the place to decide what a viewer may see. The handle is
 * already in the URL, so it discloses nothing new.
 */
export async function generateMetadata({ params }: ProfilePageProps): Promise<Metadata> {
  const { username } = await params;
  return { title: `@${username}` };
}

export default async function ProfilePage({ params }: ProfilePageProps) {
  const { username } = await params;
  return <ProfileView username={username} />;
}
