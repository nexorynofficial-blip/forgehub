/**
 * Development seed (BACKEND_ARCHITECTURE.md §3).
 *
 * ─── DEVELOPMENT DATA ONLY ────────────────────────────────────────────────
 * Every record here is fictional and exists to make local development and
 * manual QA possible. It must never run against production:
 *   - the script refuses to execute when NODE_ENV=production
 *   - all password hashes derive from one well-known development password,
 *     which is printed on completion rather than hidden
 *   - all ids are deterministic UUIDv5-style constants, so re-running the
 *     seed updates the same rows instead of duplicating them
 *
 * Content mirrors the frontend's existing mock fixtures (`src/lib/mock/*`)
 * so a seeded database renders the same UI the mock services produce today.
 */

import {
  PrismaClient,
  type Prisma,
  ProjectMemberRole,
  ProjectStatus,
  FundingStage,
  PostType,
  CommunityRole,
  NotificationType,
  EntityType,
  UserRole,
} from "@prisma/client";

import { hashPassword } from "../src/utils/password.js";

const prisma = new PrismaClient();

/** Marks every seeded row so development data is identifiable at a glance. */
const SEED_TAG = "[dev-seed]";

/**
 * The single development password behind every seeded account. Deliberately
 * weak and public — these are not credentials, they are fixtures.
 *
 * Phase 3 replaced the former placeholder string with a real Argon2id digest
 * produced by the application's own `hashPassword`, so seeded accounts can
 * actually sign in. Each user is hashed separately, so the six rows carry six
 * different salts even though the password is the same.
 */
const DEV_PASSWORD = "DevPassword123";

/** Fixed ids keep the seed idempotent and make cross-entity wiring readable. */
const ID = {
  users: {
    ava: "00000000-0000-4000-8000-000000000001",
    dana: "00000000-0000-4000-8000-000000000002",
    riko: "00000000-0000-4000-8000-000000000003",
    amaka: "00000000-0000-4000-8000-000000000004",
    theo: "00000000-0000-4000-8000-000000000005",
    lena: "00000000-0000-4000-8000-000000000006",
  },
  projects: {
    coastline: "00000000-0000-4000-8100-000000000001",
    tidalNotes: "00000000-0000-4000-8100-000000000002",
    pixelforge: "00000000-0000-4000-8100-000000000003",
    forgeComponents: "00000000-0000-4000-8100-000000000004",
  },
  communities: {
    aiTooling: "00000000-0000-4000-8200-000000000001",
    indieSaas: "00000000-0000-4000-8200-000000000002",
    designSystems: "00000000-0000-4000-8200-000000000003",
  },
  posts: {
    milestone: "00000000-0000-4000-8300-000000000001",
    poll: "00000000-0000-4000-8300-000000000002",
    code: "00000000-0000-4000-8300-000000000003",
    announcement: "00000000-0000-4000-8300-000000000004",
  },
  conversation: "00000000-0000-4000-8400-000000000001",
} as const;

const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 3_600_000);
const daysAgo = (days: number): Date => new Date(Date.now() - days * 86_400_000);

// ── Users ─────────────────────────────────────────────────────────────────

interface SeedUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  role: UserRole;
  bio: string;
  skills: string[];
  techStack: string[];
  xp: number;
  builderRank: string;
}

const USERS: SeedUser[] = [
  {
    id: ID.users.ava,
    email: "ava@forgehub.dev",
    username: "ava.codes",
    displayName: "Ava Whitfield",
    // Platform admin so the Admin section is reachable in local development,
    // matching the frontend's mockCurrentUser.
    role: UserRole.platform_admin,
    bio: "Building Coastline CRM in public. Previously design systems at scale.",
    skills: ["Product", "TypeScript", "Design Systems"],
    techStack: ["Next.js", "PostgreSQL", "Tailwind"],
    xp: 8420,
    builderRank: "Architect",
  },
  {
    id: ID.users.dana,
    email: "dana@forgehub.dev",
    username: "dana.builds",
    displayName: "Dana Okafor",
    role: UserRole.verified_builder,
    bio: "Founder of Tidal Notes. Offline-first everything.",
    skills: ["Product", "Rust", "Offline Sync"],
    techStack: ["Next.js", "SQLite", "CRDT"],
    xp: 14800,
    builderRank: "Visionary",
  },
  {
    id: ID.users.riko,
    email: "riko@forgehub.dev",
    username: "riko.tanaka",
    displayName: "Riko Tanaka",
    role: UserRole.verified_builder,
    bio: "Indie hacker. Shipping Pixelforge, an in-browser sprite editor.",
    skills: ["Graphics", "WebGL"],
    techStack: ["TypeScript", "WebGL", "Canvas"],
    xp: 12900,
    builderRank: "Architect",
  },
  {
    id: ID.users.amaka,
    email: "amaka@forgehub.dev",
    username: "amaka.chukwu",
    displayName: "Amaka Chukwu",
    role: UserRole.member,
    bio: "Ledgerline — invoicing that respects freelancers.",
    skills: ["Fintech", "Go"],
    techStack: ["Go", "PostgreSQL"],
    xp: 7600,
    builderRank: "Craftsperson",
  },
  {
    id: ID.users.theo,
    email: "theo@forgehub.dev",
    username: "theo.marchetti",
    displayName: "Theo Marchetti",
    role: UserRole.moderator,
    bio: "ML engineer. Benchmarking models so you don't have to.",
    skills: ["Machine Learning", "Evals"],
    techStack: ["Python", "PyTorch"],
    xp: 7000,
    builderRank: "Craftsperson",
  },
  {
    id: ID.users.lena,
    email: "lena@forgehub.dev",
    username: "lena.brandt",
    displayName: "Lena Brandt",
    role: UserRole.member,
    bio: "Frontend engineer who cares about motion and accessibility.",
    skills: ["Frontend", "Accessibility", "Motion"],
    techStack: ["React", "Framer Motion"],
    xp: 5400,
    builderRank: "Builder",
  },
];

async function seedUsers(): Promise<void> {
  for (const user of USERS) {
    const passwordHash = await hashPassword(DEV_PASSWORD);

    await prisma.user.upsert({
      where: { id: user.id },
      // Re-hashed on every run so a database seeded before Phase 3 (when the
      // stored value was an unusable placeholder) is repaired in place rather
      // than needing a reset. Still idempotent — the row's shape is unchanged
      // and the credential it represents is the same one.
      update: { passwordHash },
      create: {
        id: user.id,
        email: user.email,
        username: user.username,
        displayName: user.displayName,
        passwordHash,
        role: user.role,
        emailVerified: true,
        emailVerifiedAt: daysAgo(30),
        xp: user.xp,
        builderRank: user.builderRank,
        dailyStreak: 12,
        contributionScore: Math.floor(user.xp / 10),
        communityScore: Math.floor(user.xp / 20),
        lastActiveAt: hoursAgo(2),
        createdAt: daysAgo(120),
        profile: {
          create: {
            bio: `${user.bio} ${SEED_TAG}`,
            location: "Remote",
            websiteUrl: `https://example.dev/${user.username}`,
            skills: user.skills,
            techStack: user.techStack,
            experienceYears: 6,
            completionPercent: 90,
            socialLinks: {
              create: [
                { platform: "github", url: `https://github.com/${user.username}` },
                { platform: "x", url: `https://x.com/${user.username}` },
              ],
            },
          },
        },
        settings: { create: {} },
        // One preference row per notification type, matching the Settings matrix.
        notificationPrefs: {
          create: Object.values(NotificationType).map((type) => ({
            type,
            inApp: true,
            email: type === NotificationType.message,
          })),
        },
      },
    });
  }
  console.log(`  ✓ ${USERS.length} users (+ profiles, settings, preferences)`);
}

// ── Social graph ──────────────────────────────────────────────────────────

async function seedFollows(): Promise<void> {
  const { ava, dana, riko, amaka, theo, lena } = ID.users;
  const pairs: Array<[string, string]> = [
    [ava, dana],
    [ava, riko],
    [ava, lena],
    [dana, ava],
    [riko, ava],
    [lena, ava],
    [amaka, dana],
    [theo, riko],
  ];

  for (const [followerId, followingId] of pairs) {
    await prisma.follow.upsert({
      where: { followerId_followingId: { followerId, followingId } },
      update: {},
      create: { followerId, followingId },
    });
  }

  // Counters are denormalized, so the seed must maintain them exactly as a
  // service would — recomputed here rather than hand-written, so they cannot
  // drift from the rows above.
  for (const userId of Object.values(ID.users)) {
    const [followersCount, followingCount, projectsCount] = await Promise.all([
      prisma.follow.count({ where: { followingId: userId } }),
      prisma.follow.count({ where: { followerId: userId } }),
      prisma.project.count({ where: { ownerId: userId, deletedAt: null } }),
    ]);
    await prisma.user.update({
      where: { id: userId },
      data: { followersCount, followingCount, projectsCount },
    });
  }
  console.log(`  ✓ ${pairs.length} follows (counters recomputed)`);
}

// ── Tags ──────────────────────────────────────────────────────────────────

const TAG_NAMES = [
  "AI",
  "SaaS",
  "Design Systems",
  "Open Source",
  "Developer Tools",
  "Fintech",
  "Accessibility",
];

async function seedTags(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const name of TAG_NAMES) {
    const slug = name.toLowerCase().replace(/\s+/g, "-");
    const tag = await prisma.tag.upsert({
      where: { slug },
      update: {},
      create: { slug, name },
    });
    map.set(name, tag.id);
  }
  console.log(`  ✓ ${TAG_NAMES.length} tags`);
  return map;
}

// ── Projects ──────────────────────────────────────────────────────────────

async function seedProjects(tags: Map<string, string>): Promise<void> {
  const projects: Array<{
    id: string;
    slug: string;
    ownerId: string;
    title: string;
    description: string;
    status: ProjectStatus;
    fundingStage: FundingStage;
    progressPercent: number;
    techStack: string[];
    tagNames: string[];
  }> = [
    {
      id: ID.projects.coastline,
      slug: "coastline-crm",
      ownerId: ID.users.ava,
      title: "Coastline CRM",
      description: "A CRM that respects small teams — no seat minimums, no bloat.",
      status: ProjectStatus.launched,
      fundingStage: FundingStage.bootstrapped,
      progressPercent: 85,
      techStack: ["Next.js", "PostgreSQL", "Prisma"],
      tagNames: ["SaaS", "Developer Tools"],
    },
    {
      id: ID.projects.tidalNotes,
      slug: "tidal-notes",
      ownerId: ID.users.dana,
      title: "Tidal Notes",
      description: "Markdown notes that sync across devices with offline-first sync.",
      status: ProjectStatus.launched,
      fundingStage: FundingStage.pre_seed,
      progressPercent: 92,
      techStack: ["Next.js", "SQLite", "CRDT"],
      tagNames: ["SaaS", "Open Source"],
    },
    {
      id: ID.projects.pixelforge,
      slug: "pixelforge",
      ownerId: ID.users.riko,
      title: "Pixelforge",
      description: "An in-browser sprite editor with real-time collaboration.",
      status: ProjectStatus.beta,
      fundingStage: FundingStage.not_seeking,
      progressPercent: 64,
      techStack: ["TypeScript", "WebGL", "Canvas"],
      tagNames: ["Developer Tools", "Open Source"],
    },
    {
      id: ID.projects.forgeComponents,
      slug: "forge-components",
      ownerId: ID.users.lena,
      title: "Forge Components",
      description: "An accessible React component library with motion built in.",
      status: ProjectStatus.in_progress,
      fundingStage: FundingStage.not_seeking,
      progressPercent: 47,
      techStack: ["React", "Tailwind", "Framer Motion"],
      tagNames: ["Design Systems", "Accessibility", "Open Source"],
    },
  ];

  for (const project of projects) {
    const { tagNames, ...data } = project;

    await prisma.project.upsert({
      where: { id: project.id },
      update: {},
      create: {
        ...data,
        description: `${data.description} ${SEED_TAG}`,
        coverImageUrl: null,
        gallery: [],
        viewsCount: 1200,
        likesCount: 240,
        followersCount: 88,
        createdAt: daysAgo(90),
        // The owner is also a member — membership is the single source of
        // truth for project access checks in later phases.
        members: {
          create: [{ userId: data.ownerId, role: ProjectMemberRole.owner }],
        },
        milestones: {
          create: [
            {
              title: "Private alpha",
              description: "Ship to the first 20 users.",
              isComplete: true,
              completedAt: daysAgo(60),
              position: 0,
            },
            {
              title: "Public beta",
              description: "Open signups and publish the changelog.",
              isComplete: project.progressPercent > 60,
              targetDate: daysAgo(-14),
              position: 1,
            },
            {
              title: "1.0 launch",
              description: "Billing, docs, and a real landing page.",
              isComplete: false,
              targetDate: daysAgo(-60),
              position: 2,
            },
          ],
        },
        updates: {
          create: [
            {
              authorId: data.ownerId,
              content: `Shipped the new onboarding flow this week. ${SEED_TAG}`,
              createdAt: daysAgo(5),
            },
          ],
        },
        tags: {
          create: tagNames
            .map((name) => tags.get(name))
            .filter((tagId): tagId is string => tagId !== undefined)
            .map((tagId) => ({ tagId })),
        },
      },
    });
  }

  // A second member on one project exercises the multi-member UI.
  await prisma.projectMember.upsert({
    where: {
      projectId_userId: {
        projectId: ID.projects.forgeComponents,
        userId: ID.users.theo,
      },
    },
    update: {},
    create: {
      projectId: ID.projects.forgeComponents,
      userId: ID.users.theo,
      role: ProjectMemberRole.developer,
    },
  });

  console.log(`  ✓ ${projects.length} projects (+ members, milestones, updates, tags)`);
}

// ── Communities ───────────────────────────────────────────────────────────

async function seedCommunities(tags: Map<string, string>): Promise<void> {
  const communities = [
    {
      id: ID.communities.aiTooling,
      slug: "ai-tooling",
      name: "AI Tooling",
      description: "Builders shipping AI-powered products — models, agents, and evals.",
      category: "Artificial Intelligence",
      ownerId: ID.users.theo,
      tagNames: ["AI", "Developer Tools"],
    },
    {
      id: ID.communities.indieSaas,
      slug: "indie-saas",
      name: "Indie SaaS",
      description: "Solo and small-team founders building their own SaaS in public.",
      category: "Startups",
      ownerId: ID.users.dana,
      tagNames: ["SaaS"],
    },
    {
      id: ID.communities.designSystems,
      slug: "design-systems",
      name: "Design Systems",
      description: "Design tokens, component APIs, accessibility, and everything after.",
      category: "Design",
      ownerId: ID.users.lena,
      tagNames: ["Design Systems", "Accessibility"],
    },
  ];

  for (const community of communities) {
    const { tagNames, ...data } = community;

    await prisma.community.upsert({
      where: { id: community.id },
      update: {},
      create: {
        ...data,
        description: `${data.description} ${SEED_TAG}`,
        createdAt: daysAgo(150),
        members: {
          create: [{ userId: data.ownerId, role: CommunityRole.owner }],
        },
        rules: {
          create: [
            {
              content: "Be constructive — critique the work, not the person.",
              position: 0,
            },
            {
              content: "No unsolicited promotion outside the launch threads.",
              position: 1,
            },
            {
              content: "Share what you learned, not just what you shipped.",
              position: 2,
            },
          ],
        },
        events: {
          create: [
            {
              title: `${data.name}: Show & Tell`,
              description: "Monthly demo night — five minutes each.",
              startsAt: daysAgo(-7),
              endsAt: daysAgo(-7),
              isOnline: true,
              attendeeCount: 64,
            },
          ],
        },
        tags: {
          create: tagNames
            .map((name) => tags.get(name))
            .filter((tagId): tagId is string => tagId !== undefined)
            .map((tagId) => ({ tagId })),
        },
      },
    });
  }

  // Spread the rest of the users across communities so member lists render.
  const memberships: Array<[string, string, CommunityRole]> = [
    [ID.communities.aiTooling, ID.users.ava, CommunityRole.member],
    [ID.communities.aiTooling, ID.users.riko, CommunityRole.moderator],
    [ID.communities.indieSaas, ID.users.ava, CommunityRole.moderator],
    [ID.communities.indieSaas, ID.users.amaka, CommunityRole.member],
    [ID.communities.designSystems, ID.users.ava, CommunityRole.member],
    [ID.communities.designSystems, ID.users.theo, CommunityRole.member],
  ];

  for (const [communityId, userId, role] of memberships) {
    await prisma.communityMember.upsert({
      where: { communityId_userId: { communityId, userId } },
      update: {},
      create: { communityId, userId, role },
    });
  }

  for (const communityId of Object.values(ID.communities)) {
    const memberCount = await prisma.communityMember.count({ where: { communityId } });
    await prisma.community.update({ where: { id: communityId }, data: { memberCount } });
  }

  console.log(`  ✓ ${communities.length} communities (+ members, rules, events, tags)`);
}

// ── Posts, comments, engagement ───────────────────────────────────────────

async function seedPosts(): Promise<void> {
  await prisma.post.upsert({
    where: { id: ID.posts.milestone },
    update: {},
    create: {
      id: ID.posts.milestone,
      authorId: ID.users.dana,
      projectId: ID.projects.tidalNotes,
      type: PostType.milestone,
      content: `Tidal Notes just crossed 1,000 active users. Offline-first sync was the right bet. ${SEED_TAG}`,
      createdAt: hoursAgo(2),
    },
  });

  await prisma.post.upsert({
    where: { id: ID.posts.poll },
    update: {},
    create: {
      id: ID.posts.poll,
      authorId: ID.users.amaka,
      type: PostType.poll,
      content: `Planning Ledgerline's next milestone — what should I prioritize? ${SEED_TAG}`,
      createdAt: hoursAgo(9),
      poll: {
        create: {
          question: "What should Ledgerline ship next?",
          closesAt: daysAgo(-2),
          options: {
            create: [
              { label: "Recurring invoices", position: 0, voteCount: 84 },
              { label: "Multi-currency support", position: 1, voteCount: 51 },
              { label: "Client portal", position: 2, voteCount: 63 },
            ],
          },
        },
      },
    },
  });

  await prisma.post.upsert({
    where: { id: ID.posts.code },
    update: {},
    create: {
      id: ID.posts.code,
      authorId: ID.users.lena,
      projectId: ID.projects.forgeComponents,
      communityId: ID.communities.designSystems,
      type: PostType.code,
      content: `Typed variant props without the string-concat mess. ${SEED_TAG}`,
      codeLanguage: "typescript",
      codeContent: [
        "type ButtonVariants = VariantProps<typeof buttonVariants>;",
        "",
        "export function Button({ variant, size, ...props }: ButtonVariants) {",
        "  return <button className={buttonVariants({ variant, size })} {...props} />;",
        "}",
      ].join("\n"),
      createdAt: hoursAgo(6),
    },
  });

  await prisma.post.upsert({
    where: { id: ID.posts.announcement },
    update: {},
    create: {
      id: ID.posts.announcement,
      authorId: ID.users.ava,
      projectId: ID.projects.coastline,
      type: PostType.announcement,
      content: `Coastline CRM is now open for public signups — no more waitlist. ${SEED_TAG}`,
      createdAt: hoursAgo(20),
    },
  });

  // Comments, including one reply, so the nested-comment path is exercised.
  const rootComment = await prisma.comment.upsert({
    where: { id: "00000000-0000-4000-8500-000000000001" },
    update: {},
    create: {
      id: "00000000-0000-4000-8500-000000000001",
      postId: ID.posts.milestone,
      authorId: ID.users.ava,
      content: `Congrats — offline-first is hard to get right. ${SEED_TAG}`,
      createdAt: hoursAgo(1),
    },
  });

  await prisma.comment.upsert({
    where: { id: "00000000-0000-4000-8500-000000000002" },
    update: {},
    create: {
      id: "00000000-0000-4000-8500-000000000002",
      postId: ID.posts.milestone,
      authorId: ID.users.dana,
      parentCommentId: rootComment.id,
      content: `Thanks! The CRDT merge was the hardest part. ${SEED_TAG}`,
      createdAt: hoursAgo(1),
    },
  });

  // Likes and bookmarks, then recompute the denormalized counters.
  const likes: Array<[string, string]> = [
    [ID.posts.milestone, ID.users.ava],
    [ID.posts.milestone, ID.users.riko],
    [ID.posts.milestone, ID.users.lena],
    [ID.posts.poll, ID.users.ava],
    [ID.posts.code, ID.users.ava],
  ];

  for (const [postId, userId] of likes) {
    await prisma.postLike.upsert({
      where: { postId_userId: { postId, userId } },
      update: {},
      create: { postId, userId },
    });
  }

  await prisma.bookmark.upsert({
    where: { postId_userId: { postId: ID.posts.code, userId: ID.users.ava } },
    update: {},
    create: { postId: ID.posts.code, userId: ID.users.ava },
  });

  for (const postId of Object.values(ID.posts)) {
    const [likesCount, commentsCount] = await Promise.all([
      prisma.postLike.count({ where: { postId } }),
      prisma.comment.count({ where: { postId, deletedAt: null } }),
    ]);
    await prisma.post.update({
      where: { id: postId },
      data: { likesCount, commentsCount },
    });
  }

  // Pin one post into its community.
  await prisma.communityPinnedPost.upsert({
    where: {
      communityId_postId: {
        communityId: ID.communities.designSystems,
        postId: ID.posts.code,
      },
    },
    update: {},
    create: {
      communityId: ID.communities.designSystems,
      postId: ID.posts.code,
      pinnedById: ID.users.lena,
    },
  });

  console.log("  ✓ 4 posts (+ poll, comments, replies, likes, bookmark, pin)");
}

// ── Messaging ─────────────────────────────────────────────────────────────

async function seedConversations(): Promise<void> {
  await prisma.conversation.upsert({
    where: { id: ID.conversation },
    update: {},
    create: {
      id: ID.conversation,
      isGroup: false,
      createdById: ID.users.ava,
      lastMessageAt: hoursAgo(1),
      members: {
        create: [
          { userId: ID.users.ava, lastReadAt: hoursAgo(1) },
          { userId: ID.users.dana, lastReadAt: hoursAgo(3) },
        ],
      },
      messages: {
        create: [
          {
            id: "00000000-0000-4000-8600-000000000001",
            senderId: ID.users.dana,
            content: `Hey — did you see the sync conflict on the CRDT merge? ${SEED_TAG}`,
            createdAt: hoursAgo(4),
          },
          {
            id: "00000000-0000-4000-8600-000000000002",
            senderId: ID.users.ava,
            content: `Not yet, was heads down on Coastline. Got a link? ${SEED_TAG}`,
            createdAt: hoursAgo(3),
          },
          {
            id: "00000000-0000-4000-8600-000000000003",
            senderId: ID.users.dana,
            content: `Here's the branch — looks like a race on concurrent edits. ${SEED_TAG}`,
            createdAt: hoursAgo(1),
          },
        ],
      },
    },
  });

  await prisma.messageReaction.upsert({
    where: {
      messageId_userId_emoji: {
        messageId: "00000000-0000-4000-8600-000000000003",
        userId: ID.users.ava,
        emoji: "👀",
      },
    },
    update: {},
    create: {
      messageId: "00000000-0000-4000-8600-000000000003",
      userId: ID.users.ava,
      emoji: "👀",
    },
  });

  console.log("  ✓ 1 conversation (+ 3 messages, 1 reaction, read state)");
}

// ── Achievements ──────────────────────────────────────────────────────────

const ACHIEVEMENTS = [
  {
    slug: "first-project",
    name: "First Project",
    description: "Created your first project.",
    points: 50,
  },
  {
    slug: "first-post",
    name: "First Post",
    description: "Shared your first build update.",
    points: 25,
  },
  {
    slug: "first-collaboration",
    name: "First Collaboration",
    description: "Joined a project as a collaborator.",
    points: 75,
  },
  {
    slug: "community-builder",
    name: "Community Builder",
    description: "Founded a community.",
    points: 100,
  },
  {
    slug: "consistent-builder",
    name: "Consistent Builder",
    description: "Posted an update seven days running.",
    points: 150,
  },
  {
    slug: "project-launcher",
    name: "Project Launcher",
    description: "Took a project to launched.",
    points: 200,
  },
  {
    slug: "thousand-users",
    name: "1K Users",
    description: "Reached 1,000 active users on a project.",
    points: 300,
  },
];

async function seedAchievements(): Promise<void> {
  for (const achievement of ACHIEVEMENTS) {
    await prisma.achievement.upsert({
      where: { slug: achievement.slug },
      update: {},
      create: achievement,
    });
  }

  const firstProject = await prisma.achievement.findUniqueOrThrow({
    where: { slug: "first-project" },
  });
  const launcher = await prisma.achievement.findUniqueOrThrow({
    where: { slug: "project-launcher" },
  });

  const awards: Array<[string, string]> = [
    [ID.users.ava, firstProject.id],
    [ID.users.ava, launcher.id],
    [ID.users.dana, firstProject.id],
    [ID.users.dana, launcher.id],
    [ID.users.riko, firstProject.id],
  ];

  for (const [userId, achievementId] of awards) {
    await prisma.userAchievement.upsert({
      where: { userId_achievementId: { userId, achievementId } },
      update: {},
      create: { userId, achievementId },
    });
  }

  console.log(`  ✓ ${ACHIEVEMENTS.length} achievements (+ ${awards.length} awarded)`);
}

// ── Notifications ─────────────────────────────────────────────────────────

async function seedNotifications(): Promise<void> {
  const notifications: Prisma.NotificationCreateManyInput[] = [
    {
      userId: ID.users.dana,
      actorId: ID.users.ava,
      type: NotificationType.like,
      entityType: EntityType.post,
      entityId: ID.posts.milestone,
      message: "Ava Whitfield liked your milestone",
      createdAt: hoursAgo(1),
    },
    {
      userId: ID.users.dana,
      actorId: ID.users.ava,
      type: NotificationType.comment,
      entityType: EntityType.post,
      entityId: ID.posts.milestone,
      message: "Ava Whitfield commented on your post",
      createdAt: hoursAgo(1),
    },
    {
      userId: ID.users.ava,
      actorId: ID.users.lena,
      type: NotificationType.follower,
      entityType: EntityType.user,
      entityId: ID.users.lena,
      message: "Lena Brandt started following you",
      createdAt: hoursAgo(5),
    },
    {
      userId: ID.users.ava,
      actorId: null,
      type: NotificationType.achievement,
      entityType: EntityType.achievement,
      entityId: null,
      message: "You unlocked Project Launcher",
      isRead: true,
      readAt: hoursAgo(20),
      createdAt: daysAgo(2),
    },
  ];

  // Notifications carry no natural key, so a re-run clears the seeded set
  // first rather than accumulating duplicates.
  await prisma.notification.deleteMany({
    where: { userId: { in: Object.values(ID.users) } },
  });
  await prisma.notification.createMany({ data: notifications });

  console.log(`  ✓ ${notifications.length} notifications`);
}

// ── Entrypoint ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("Refusing to seed: NODE_ENV=production. This is development data.");
  }

  console.log(`\nSeeding ForgeHub development database ${SEED_TAG}\n`);

  await seedUsers();
  const tags = await seedTags();
  await seedProjects(tags);
  await seedCommunities(tags);
  await seedFollows();
  await seedPosts();
  await seedConversations();
  await seedAchievements();
  await seedNotifications();

  console.log(
    [
      "",
      "Seed complete.",
      "",
      "  DEVELOPMENT DATA ONLY — every account below is fictional.",
      `  Sign-in password for all seeded users: ${DEV_PASSWORD}`,
      "  (stored as a real Argon2id digest — these accounts can sign in)",
      "",
      `  Demo admin: ${USERS[0]?.email} (${USERS[0]?.username})`,
      "",
    ].join("\n"),
  );
}

main()
  .catch((error: unknown) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
