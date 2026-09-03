"use client";

import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { ApiError, apiErrorMessage, applyApiFieldErrors } from "@/lib/api";
import { PROJECT_FUNDING_META, PROJECT_STATUS_META } from "@/lib/project-meta";
import { queryKeys } from "@/lib/query-keys";
import { routes } from "@/lib/routes";
import { createProject } from "@/lib/services/project-service";
import {
  createProjectSchema,
  fundingStageValues,
  projectStatusValues,
  projectVisibilityValues,
  type CreateProjectFormValues,
  type CreateProjectValues,
} from "@/lib/validations/project";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/** How each visibility choice actually behaves, in the user's terms. */
const VISIBILITY_META: Record<
  (typeof projectVisibilityValues)[number],
  { label: string; hint: string }
> = {
  public: { label: "Public", hint: "Listed in discovery and visible to everyone." },
  unlisted: { label: "Unlisted", hint: "Not listed, but anyone with the link can view." },
  private: { label: "Private", hint: "Only you and members you add can view it." },
};

/**
 * Creating a project.
 *
 * The whole form is derived from the backend's `createProjectSchema`, which
 * requires only a title — so the form does too, and every other control writes
 * a value the API already defaults. Nothing here is invented: `tags`,
 * `coverImageUrl` and `gallery` are absent for the reasons
 * `lib/validations/project.ts` records.
 *
 * Success is the server's answer, never a guess. The redirect uses the slug
 * the API returns, because the slug is derived server-side from the title and
 * is deduplicated there — a client-side slugify would send the user to the
 * wrong project the first time two people ship something with the same name.
 */
export function NewProjectForm() {
  const router = useRouter();
  const toast = useToast((state) => state.toast);
  const queryClient = useQueryClient();

  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateProjectFormValues, unknown, CreateProjectValues>({
    resolver: zodResolver(createProjectSchema),
    defaultValues: {
      title: "",
      description: "",
      techStack: "",
      status: "idea",
      fundingStage: "bootstrapped",
      visibility: "public",
      demoUrl: "",
      repositoryUrl: "",
      documentationUrl: "",
    },
  });

  const mutation = useMutation({
    mutationFn: (values: CreateProjectValues) =>
      createProject({
        title: values.title,
        ...(values.description ? { description: values.description } : {}),
        techStack: values.techStack,
        status: values.status,
        fundingStage: values.fundingStage,
        visibility: values.visibility,
        // The API treats "" as "no URL" and stores null; sending the empty
        // string is what its `optionalUrl` union is built to accept.
        demoUrl: values.demoUrl ?? "",
        repositoryUrl: values.repositoryUrl ?? "",
        documentationUrl: values.documentationUrl ?? "",
      }),
    onSuccess: (project) => {
      // The lists this project now belongs to are stale. Invalidating rather
      // than inserting keeps ordering and pagination the server's business.
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      toast({ title: "Project created", description: `${project.title} is live.` });
      router.push(routes.project(project.slug));
    },
    onError: (error) => {
      // A 422 lands on the field that caused it, where the user can fix it.
      if (
        applyApiFieldErrors(error, setError, [
          "title",
          "description",
          "techStack",
          "status",
          "fundingStage",
          "visibility",
          "demoUrl",
          "repositoryUrl",
          "documentationUrl",
        ])
      ) {
        return;
      }

      if (error instanceof ApiError && error.isConflict) {
        setError("title", {
          type: "server",
          message: "You already have a project with this title.",
        });
        return;
      }

      toast({
        variant: "danger",
        title:
          error instanceof ApiError && error.isRateLimited
            ? "Too many attempts"
            : "Could not create the project",
        description: apiErrorMessage(error, "Please try again in a moment."),
      });
    },
  });

  const isBusy = isSubmitting || mutation.isPending;

  return (
    <form
      onSubmit={handleSubmit((values) => mutation.mutate(values))}
      noValidate
      className="flex flex-col gap-6"
    >
      <Card>
        <CardContent className="flex flex-col gap-5 pt-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              autoComplete="off"
              placeholder="What are you building?"
              aria-invalid={!!errors.title}
              aria-describedby={errors.title ? "title-error" : undefined}
              {...register("title")}
            />
            {errors.title && (
              <p id="title-error" className="text-danger text-sm">
                {errors.title.message}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              rows={5}
              placeholder="What problem does it solve, and where is it now?"
              aria-invalid={!!errors.description}
              aria-describedby={
                errors.description ? "description-error" : "description-hint"
              }
              {...register("description")}
            />
            {errors.description ? (
              <p id="description-error" className="text-danger text-sm">
                {errors.description.message}
              </p>
            ) : (
              <p id="description-hint" className="text-muted-foreground text-xs">
                Optional. Up to 2000 characters.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="techStack">Tech stack</Label>
            <Input
              id="techStack"
              autoComplete="off"
              placeholder="Next.js, PostgreSQL, Prisma"
              aria-invalid={!!errors.techStack}
              aria-describedby={errors.techStack ? "techStack-error" : "techStack-hint"}
              {...register("techStack")}
            />
            {errors.techStack ? (
              <p id="techStack-error" className="text-danger text-sm">
                {errors.techStack.message}
              </p>
            ) : (
              <p id="techStack-hint" className="text-muted-foreground text-xs">
                Comma separated. Up to 30 entries.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-5 pt-6">
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="status">Status</Label>
              <Controller
                control={control}
                name="status"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {projectStatusValues.map((value) => (
                        <SelectItem key={value} value={value}>
                          {PROJECT_STATUS_META[value].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="fundingStage">Funding</Label>
              <Controller
                control={control}
                name="fundingStage"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="fundingStage">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {fundingStageValues.map((value) => (
                        <SelectItem key={value} value={value}>
                          {PROJECT_FUNDING_META[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="visibility">Visibility</Label>
            <Controller
              control={control}
              name="visibility"
              render={({ field }) => (
                <>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="visibility" aria-describedby="visibility-hint">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {projectVisibilityValues.map((value) => (
                        <SelectItem key={value} value={value}>
                          {VISIBILITY_META[value].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p id="visibility-hint" className="text-muted-foreground text-xs">
                    {VISIBILITY_META[field.value].hint}
                  </p>
                </>
              )}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-5 pt-6">
          {(
            [
              ["demoUrl", "Live demo", "https://your-project.example"],
              ["repositoryUrl", "Repository", "https://github.com/you/project"],
              ["documentationUrl", "Documentation", "https://docs.your-project.example"],
            ] as const
          ).map(([name, label, placeholder]) => (
            <div key={name} className="flex flex-col gap-2">
              <Label htmlFor={name}>{label}</Label>
              <Input
                id={name}
                type="url"
                inputMode="url"
                autoComplete="off"
                placeholder={placeholder}
                aria-invalid={!!errors[name]}
                aria-describedby={errors[name] ? `${name}-error` : undefined}
                {...register(name)}
              />
              {errors[name] && (
                <p id={`${name}-error`} className="text-danger text-sm">
                  {errors[name]?.message}
                </p>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.back()}
          disabled={isBusy}
        >
          Cancel
        </Button>
        <Button type="submit" size="lg" disabled={isBusy}>
          {isBusy && <Loader2 className="size-4 animate-spin" />}
          Create project
        </Button>
      </div>
    </form>
  );
}
