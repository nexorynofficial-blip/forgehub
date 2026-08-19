"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch } from "react-hook-form";
import { Loader2 } from "lucide-react";

import {
  changePassword,
  getCurrentUser,
  updateCurrentUser,
} from "@/lib/services/user-service";
import {
  accountSchema,
  changePasswordSchema,
  type AccountValues,
  type ChangePasswordValues,
} from "@/lib/validations/settings";
import { useToast } from "@/hooks/use-toast";
import type { User } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { PasswordInput } from "@/components/auth/password-input";
import { PasswordStrengthMeter } from "@/components/auth/password-strength-meter";

function ProfileFieldsForm({ user }: { user: User }) {
  const toast = useToast((state) => state.toast);
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<AccountValues>({
    resolver: zodResolver(accountSchema),
    defaultValues: {
      displayName: user.displayName,
      username: user.username,
      email: user.email,
      bio: user.bio,
      experienceYears: user.experienceYears != null ? String(user.experienceYears) : "",
      githubUrl: user.socialLinks.find((link) => link.platform === "github")?.url ?? "",
      xUrl: user.socialLinks.find((link) => link.platform === "x")?.url ?? "",
      skills: user.skills.join(", "),
      techStack: user.techStack.join(", "),
    },
  });

  async function onSubmit(values: AccountValues) {
    await updateCurrentUser({
      displayName: values.displayName,
      username: values.username,
      email: values.email,
      bio: values.bio,
      experienceYears:
        values.experienceYears === "" ? null : Number(values.experienceYears),
      socialLinks: [
        ...(values.githubUrl ? [{ platform: "github", url: values.githubUrl }] : []),
        ...(values.xUrl ? [{ platform: "x", url: values.xUrl }] : []),
      ],
      skills: values.skills
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      techStack: values.techStack
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
    queryClient.invalidateQueries({ queryKey: ["currentUser"] });
    toast({ title: "Profile updated", description: "Your changes have been saved." });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>This is how you appear across ForgeHub.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit(onSubmit)}
          noValidate
          className="flex flex-col gap-5"
        >
          <div className="flex items-center gap-4">
            <Avatar className="size-16">
              <AvatarImage src={user.avatarUrl ?? undefined} alt="" />
              <AvatarFallback className="text-xl">
                {user.displayName.charAt(0)}
              </AvatarFallback>
            </Avatar>
            <Button type="button" variant="secondary" size="sm">
              Change avatar
            </Button>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="displayName">Display name</Label>
              <Input
                id="displayName"
                aria-invalid={!!errors.displayName}
                {...register("displayName")}
              />
              {errors.displayName && (
                <p className="text-danger text-sm">{errors.displayName.message}</p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                aria-invalid={!!errors.username}
                {...register("username")}
              />
              {errors.username && (
                <p className="text-danger text-sm">{errors.username.message}</p>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              aria-invalid={!!errors.email}
              {...register("email")}
            />
            {errors.email && (
              <p className="text-danger text-sm">{errors.email.message}</p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="bio">Bio</Label>
            <Textarea
              id="bio"
              rows={3}
              aria-invalid={!!errors.bio}
              {...register("bio")}
            />
            {errors.bio && <p className="text-danger text-sm">{errors.bio.message}</p>}
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="experienceYears">Years of experience</Label>
              <Input
                id="experienceYears"
                type="number"
                min={0}
                max={60}
                {...register("experienceYears")}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="githubUrl">GitHub URL</Label>
              <Input
                id="githubUrl"
                aria-invalid={!!errors.githubUrl}
                {...register("githubUrl")}
              />
              {errors.githubUrl && (
                <p className="text-danger text-sm">{errors.githubUrl.message}</p>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="xUrl">X (Twitter) URL</Label>
            <Input id="xUrl" aria-invalid={!!errors.xUrl} {...register("xUrl")} />
            {errors.xUrl && <p className="text-danger text-sm">{errors.xUrl.message}</p>}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="skills">Skills</Label>
            <Input
              id="skills"
              placeholder="TypeScript, React, Systems Design"
              {...register("skills")}
            />
            <p className="text-muted-foreground text-xs">Comma-separated.</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="techStack">Tech stack</Label>
            <Input
              id="techStack"
              placeholder="Next.js, Node.js, PostgreSQL"
              {...register("techStack")}
            />
            <p className="text-muted-foreground text-xs">Comma-separated.</p>
          </div>

          <Button type="submit" className="self-start" disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="size-4 animate-spin" />}
            Save changes
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ChangePasswordForm() {
  const toast = useToast((state) => state.toast);
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmNewPassword: "" },
  });
  const newPassword = useWatch({ control, name: "newPassword" });

  async function onSubmit(values: ChangePasswordValues) {
    await changePassword(values.currentPassword, values.newPassword);
    toast({
      title: "Password updated",
      description: "Use your new password next time you sign in.",
    });
    reset();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>Change the password used to sign in.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit(onSubmit)}
          noValidate
          className="flex flex-col gap-5"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="currentPassword">Current password</Label>
            <PasswordInput
              id="currentPassword"
              autoComplete="current-password"
              aria-invalid={!!errors.currentPassword}
              {...register("currentPassword")}
            />
            {errors.currentPassword && (
              <p className="text-danger text-sm">{errors.currentPassword.message}</p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="newPassword">New password</Label>
            <PasswordInput
              id="newPassword"
              autoComplete="new-password"
              aria-invalid={!!errors.newPassword}
              {...register("newPassword")}
            />
            <PasswordStrengthMeter password={newPassword ?? ""} />
            {errors.newPassword && (
              <p className="text-danger text-sm">{errors.newPassword.message}</p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="confirmNewPassword">Confirm new password</Label>
            <PasswordInput
              id="confirmNewPassword"
              autoComplete="new-password"
              aria-invalid={!!errors.confirmNewPassword}
              {...register("confirmNewPassword")}
            />
            {errors.confirmNewPassword && (
              <p className="text-danger text-sm">{errors.confirmNewPassword.message}</p>
            )}
          </div>
          <Button type="submit" className="self-start" disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="size-4 animate-spin" />}
            Update password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function DangerZone() {
  const toast = useToast((state) => state.toast);
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleDelete() {
    setIsDeleting(true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    setIsDeleting(false);
    toast({
      title: "Account deletion isn't wired up yet",
      description: "This is a mock action — no account was deleted.",
      variant: "danger",
    });
  }

  return (
    <Card className="border-danger/40">
      <CardHeader>
        <CardTitle>Danger zone</CardTitle>
        <CardDescription>
          Permanently delete your account and all of your data.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="danger">Delete account</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete your account?</DialogTitle>
              <DialogDescription>
                This can&apos;t be undone. All of your projects, posts, and messages will
                be permanently removed.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="danger" onClick={handleDelete} disabled={isDeleting}>
                {isDeleting && <Loader2 className="size-4 animate-spin" />}
                Yes, delete my account
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

export function AccountForm() {
  const { data: user, isLoading } = useQuery({
    queryKey: ["currentUser"],
    queryFn: getCurrentUser,
  });

  if (isLoading || !user) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-96" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <ProfileFieldsForm user={user} />
      <ChangePasswordForm />
      <DangerZone />
    </div>
  );
}
