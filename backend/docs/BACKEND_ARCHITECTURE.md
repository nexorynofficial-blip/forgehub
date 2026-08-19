FORGEHUB — BACKEND ARCHITECTURE SPECIFICATION

Version: 1.0
Status: Development Specification

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. ARCHITECTURAL OBJECTIVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ForgeHub backend must be designed as a modular, secure, scalable backend capable of supporting a production social platform.

The architecture must support:

- REST APIs
- Real-time communication
- PostgreSQL
- Redis
- Authentication
- Authorization
- File storage
- Background jobs
- AI integrations
- Moderation
- Analytics
- Future horizontal scaling

The architecture must keep business logic independent from transport mechanisms wherever practical.

Controllers should not contain business logic.

Routes should not contain business logic.

Database access should not be scattered throughout the application.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2. HIGH-LEVEL ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The system follows this general architecture:

CLIENT

        ↓

API / SOCKET GATEWAY

        ↓

MIDDLEWARE

        ↓

CONTROLLER / SOCKET HANDLER

        ↓

SERVICE LAYER

        ↓

REPOSITORY LAYER

        ↓

PRISMA

        ↓

POSTGRESQL


Supporting infrastructure:

Redis
Cloudinary
Email Provider
AI Provider
Background Jobs

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
3. BACKEND DIRECTORY STRUCTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The final backend should use a modular structure similar to:

backend/
│
├── src/
│   │
│   ├── config/
│   │   ├── env.ts
│   │   ├── database.ts
│   │   ├── redis.ts
│   │   └── cloudinary.ts
│   │
│   ├── modules/
│   │   │
│   │   ├── auth/
│   │   │   ├── auth.controller.ts
│   │   │   ├── auth.service.ts
│   │   │   ├── auth.repository.ts
│   │   │   ├── auth.routes.ts
│   │   │   ├── auth.schema.ts
│   │   │   ├── auth.types.ts
│   │   │   └── auth.test.ts
│   │   │
│   │   ├── users/
│   │   ├── profiles/
│   │   ├── projects/
│   │   ├── posts/
│   │   ├── comments/
│   │   ├── follows/
│   │   ├── communities/
│   │   ├── messages/
│   │   ├── notifications/
│   │   ├── search/
│   │   ├── achievements/
│   │   ├── moderation/
│   │   ├── admin/
│   │   ├── uploads/
│   │   └── ai/
│   │
│   ├── middleware/
│   │   ├── auth.middleware.ts
│   │   ├── role.middleware.ts
│   │   ├── error.middleware.ts
│   │   ├── rate-limit.middleware.ts
│   │   └── validation.middleware.ts
│   │
│   ├── database/
│   │   ├── prisma.ts
│   │   └── seed.ts
│   │
│   ├── sockets/
│   │   ├── socket.ts
│   │   ├── auth.socket.ts
│   │   ├── message.socket.ts
│   │   ├── notification.socket.ts
│   │   └── presence.socket.ts
│   │
│   ├── jobs/
│   │   ├── queue.ts
│   │   ├── email.jobs.ts
│   │   ├── notification.jobs.ts
│   │   └── ai.jobs.ts
│   │
│   ├── integrations/
│   │   ├── email/
│   │   ├── cloudinary/
│   │   └── ai/
│   │
│   ├── utils/
│   │   ├── logger.ts
│   │   ├── errors.ts
│   │   ├── pagination.ts
│   │   └── response.ts
│   │
│   ├── routes/
│   │   └── index.ts
│   │
│   ├── app.ts
│   └── server.ts
│
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
│
├── tests/
│
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── package.json
├── tsconfig.json
└── README.md

The exact structure may be improved by Claude if a better modular architecture is justified.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
4. MODULE ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Each major feature should be treated as an independent module.

Example:

modules/projects/

    project.controller.ts
    project.service.ts
    project.repository.ts
    project.routes.ts
    project.schema.ts
    project.types.ts
    project.test.ts

Responsibilities:

Controller:

- Receive HTTP request
- Call service
- Return response

Service:

- Business logic
- Authorization rules
- Orchestration

Repository:

- Database operations

Schema:

- Input validation

Types:

- TypeScript contracts

Routes:

- HTTP endpoint definitions

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
5. REQUEST FLOW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Standard request:

CLIENT

↓

Express Router

↓

Authentication Middleware

↓

Validation Middleware

↓

Controller

↓

Service

↓

Repository

↓

Prisma

↓

PostgreSQL

↓

Repository

↓

Service

↓

Controller

↓

API Response

Controllers must remain thin.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
6. ERROR FLOW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Any application error should move through:

Service

↓

Error Class

↓

Express Error Middleware

↓

Structured API Response

Example:

{
  "success": false,
  "error": {
    "code": "PROJECT_NOT_FOUND",
    "message": "Project could not be found"
  }
}

Internal implementation details must never leak to the client.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
7. DATABASE ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PostgreSQL is the source of truth for persistent application data.

Prisma is the database abstraction layer.

Core entities:

User

Profile

Session

RefreshToken

EmailVerificationToken

PasswordResetToken

TwoFactorCredential

Project

ProjectMember

ProjectMilestone

ProjectUpdate

Tag

ProjectTag

Post

PostMedia

Comment

CommentLike

PostLike

Bookmark

Follow

Community

CommunityMember

CommunityRule

CommunityPost

Conversation

ConversationMember

Message

MessageReaction

Notification

Achievement

UserAchievement

Report

ModerationAction

AuditLog

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
8. USER RELATIONSHIPS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

User

    ├── Profile
    ├── Projects
    ├── Posts
    ├── Comments
    ├── Followers
    ├── Following
    ├── Communities
    ├── Conversations
    ├── Notifications
    ├── Achievements
    └── Bookmarks

A user must not be able to create duplicate follow relationships.

User email must be unique.

Username must be unique.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
9. PROJECT RELATIONSHIPS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Project

    ├── Owner
    ├── Members
    ├── Milestones
    ├── Updates
    ├── Tags
    ├── Media
    └── Posts

ProjectMember connects:

User

to

Project

and stores:

- Role
- Joined date
- Permissions

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
10. SOCIAL GRAPH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Follow:

followerId

followingId

createdAt

Unique constraint:

(followerId, followingId)

Prevent:

Self-following

Duplicate relationships

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
11. FEED ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The feed should initially use database-driven queries.

Potential ranking signals:

- Recency
- Engagement
- Follow relationships
- Community membership
- Project relevance
- User interests

Do not build a complex recommendation engine during the initial backend phase.

Create an architecture that can support one later.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
12. COMMUNITY ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Community

    ├── Owner
    ├── Members
    ├── Moderators
    ├── Rules
    ├── Posts
    └── Categories

CommunityMember:

userId

communityId

role

joinedAt

Roles:

OWNER

ADMIN

MODERATOR

MEMBER

Permissions must be verified server-side.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
13. MESSAGING ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Messaging consists of:

Conversation

ConversationMember

Message

MessageReaction

MessageAttachment

Flow:

Client

↓

Socket.IO

↓

Socket Authentication

↓

Conversation Authorization

↓

Message Service

↓

Repository

↓

PostgreSQL

↓

Socket.IO

↓

Recipient

REST endpoints should also exist for:

Conversation history

Message history

Unread counts

Search

Attachments

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
14. SOCKET.IO ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Socket connections must be authenticated.

On connection:

Client sends authentication credentials.

Server verifies identity.

Server associates socket with user.

User joins required rooms.

Example room:

user:{userId}

conversation:{conversationId}

community:{communityId}

Events:

message:new

message:typing

message:stop_typing

message:read

notification:new

presence:update

When horizontally scaled, use the Socket.IO Redis adapter.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
15. PRESENCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Redis should maintain short-lived presence information.

Example:

presence:user:{userId}

Value:

online

TTL:

short duration

Refresh while connected.

On disconnect, presence should eventually expire.

Do not rely on PostgreSQL for high-frequency presence updates.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
16. NOTIFICATION ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Notifications are persisted in PostgreSQL.

When an event occurs:

Business Service

↓

Notification Service

↓

Create Notification

↓

Emit Socket.IO Event

↓

Client

This should allow notifications to work even when the recipient is offline.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
17. AUTHENTICATION ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Registration:

Client

↓

POST /auth/register

↓

Validation

↓

Check existing user

↓

Hash password

↓

Create user

↓

Create verification token

↓

Send verification email

Login:

Client

↓

POST /auth/login

↓

Validate credentials

↓

Create session

↓

Issue access token

↓

Issue refresh token

Access tokens should be short-lived.

Refresh tokens should be revocable and rotated.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
18. AUTHORIZATION ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Authentication answers:

"Who is this user?"

Authorization answers:

"Is this user allowed to perform this action?"

Never confuse the two.

Example:

Authenticated user:

User A

Request:

DELETE /projects/123

Server checks:

Is Project 123 owned by User A?

OR

Does User A have sufficient project permissions?

If not:

403 Forbidden

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
19. REDIS ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Redis responsibilities:

- Cache
- Rate limiting
- Presence
- Temporary tokens where appropriate
- Background job queues
- Socket.IO scaling

Do not store authoritative application records exclusively in Redis.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
20. CACHE STRATEGY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Potential cached resources:

Popular communities

Trending projects

Trending posts

Public profiles

Search results

Frequently requested metadata

Cache must have explicit expiration.

When data changes:

Invalidate affected cache.

Do not introduce caching where it complicates correctness without measurable benefit.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
21. FILE UPLOAD ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Large media should be stored externally.

Preferred flow:

Client

↓

Backend authorization

↓

Upload authorization

↓

Cloudinary

↓

Cloudinary URL

↓

Backend stores metadata

PostgreSQL stores:

- URL
- Resource ID
- Type
- Size
- Owner
- CreatedAt

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
22. AI ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

AI functionality must use an abstraction.

Example:

AIService

Methods:

generateProjectSummary()

moderateContent()

suggestTags()

recommendProjects()

recommendCollaborators()

The application should call:

AIService

rather than directly calling a specific provider.

This allows provider replacement.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
23. BACKGROUND JOB ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Long-running operations should use background jobs.

Examples:

Email

AI processing

Image processing

Notification fan-out

Achievement processing

Analytics aggregation

Architecture:

API

↓

Queue

↓

Worker

↓

Service

The API should return quickly when asynchronous processing is appropriate.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
24. SEARCH ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Initial implementation:

PostgreSQL search.

Create a SearchService abstraction.

Frontend calls:

SearchService

not PostgreSQL directly.

Future implementation may replace the underlying engine with:

Meilisearch

OpenSearch

Elasticsearch

without changing the API contract.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
25. MODERATION ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Moderation flow:

User

↓

Report

↓

Report Service

↓

Moderation Queue

↓

Moderator

↓

Moderation Action

↓

Audit Log

Moderation actions:

Warning

Content removal

Temporary suspension

Permanent ban

All sensitive moderation actions must be auditable.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
26. AUDIT LOGGING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Audit events should record:

Actor

Action

Target

Target ID

Timestamp

Metadata

IP where appropriate

Examples:

USER_LOGIN

PASSWORD_CHANGED

ROLE_CHANGED

USER_BANNED

POST_REMOVED

PROJECT_DELETED

COMMUNITY_ROLE_CHANGED

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
27. SECURITY ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Security must be layered.

Layer 1:

Network / HTTPS

Layer 2:

Helmet

Layer 3:

CORS

Layer 4:

Rate limiting

Layer 5:

Authentication

Layer 6:

Authorization

Layer 7:

Input validation

Layer 8:

Database constraints

Layer 9:

Audit logging

Never trust the client.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
28. RATE LIMITING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Use Redis-backed rate limiting where appropriate.

Stricter limits:

Login

Registration

Password reset

Email verification

Messaging

Search

Public APIs vulnerable to abuse

More generous limits:

Authenticated normal API requests

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
29. API ROUTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Root:

/api/v1

Authentication:

/api/v1/auth

Users:

/api/v1/users

Profiles:

/api/v1/profiles

Projects:

/api/v1/projects

Posts:

/api/v1/posts

Comments:

/api/v1/comments

Communities:

/api/v1/communities

Messages:

/api/v1/messages

Notifications:

/api/v1/notifications

Search:

/api/v1/search

Achievements:

/api/v1/achievements

Moderation:

/api/v1/moderation

Admin:

/api/v1/admin

Uploads:

/api/v1/uploads

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
30. HEALTH ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

GET:

/health

Returns application status.

Optional readiness endpoint:

/ready

Checks:

PostgreSQL

Redis

Critical dependencies

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
31. OBSERVABILITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Every request should have a request ID.

Logs should support:

Request tracing

Error investigation

Performance analysis

Security auditing

Use structured JSON logging in production.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
32. CONFIGURATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

All environment-specific configuration must come from environment variables.

Example:

NODE_ENV

PORT

DATABASE_URL

REDIS_URL

JWT_ACCESS_SECRET

JWT_REFRESH_SECRET

JWT_ACCESS_EXPIRES

JWT_REFRESH_EXPIRES

CLOUDINARY_CLOUD_NAME

CLOUDINARY_API_KEY

CLOUDINARY_API_SECRET

EMAIL_PROVIDER

EMAIL_API_KEY

AI_PROVIDER

AI_API_KEY

CORS_ORIGIN

Never commit real secrets.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
33. FRONTEND INTEGRATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The frontend already exists.

Before creating an API:

Inspect the frontend implementation.

Determine exactly what data the frontend currently expects.

Where mock services exist:

Replace them gradually with real API services.

Do not redesign the frontend unnecessarily.

Maintain existing UX.

Maintain existing loading states.

Maintain existing error states.

Maintain optimistic interactions where appropriate.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
34. API CLIENT ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The frontend should eventually communicate with the backend through a centralized API client.

Example:

apiClient

    ├── authApi
    ├── usersApi
    ├── projectsApi
    ├── postsApi
    ├── communitiesApi
    ├── messagesApi
    ├── notificationsApi
    └── searchApi

Avoid direct fetch calls scattered throughout UI components.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
35. TESTING ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Testing layers:

Unit tests

Service tests

Repository tests where useful

API integration tests

Authentication tests

Authorization tests

Socket tests

Critical end-to-end tests

Prioritize tests for security-sensitive functionality.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
36. DEPLOYMENT ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Development:

Docker Compose

Services:

Backend

PostgreSQL

Redis

Production architecture should allow:

Load balancer

Multiple backend instances

Managed PostgreSQL

Managed Redis

External file storage

External email provider

Optional background workers

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
37. SCALING STRATEGY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Initial deployment may use a single backend instance.

The architecture must not prevent future horizontal scaling.

Stateless API design should be preferred.

Persistent/shared state belongs in:

PostgreSQL

Redis

External storage

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
38. DEVELOPMENT WORKFLOW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Backend implementation must follow this order:

Phase 1:

Project Setup

Phase 2:

Database

Phase 3:

Authentication

Phase 4:

User Profiles

Phase 5:

Projects

Phase 6:

Feed

Phase 7:

Communities

Phase 8:

Messaging

Phase 9:

Notifications

Phase 10:

Search

Phase 11:

Admin

Phase 12:

AI

Phase 13:

Testing

Phase 14:

Deployment

Phase 15:

Final Optimization

Do not skip dependencies.

Do not implement future functionality prematurely.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
39. CLAUDE CODE BEHAVIOR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Before each backend phase:

Read:

BACKEND_PRD.md

BACKEND_TRD.md

BACKEND_ARCHITECTURE.md

Relevant BACKEND phase document.

Also inspect the existing frontend.

Claude must:

- Understand existing code
- Reuse existing patterns
- Avoid unnecessary rewrites
- Keep TypeScript strict
- Validate external input
- Keep controllers thin
- Keep business logic in services
- Keep database logic in repositories
- Write tests for critical functionality
- Stop after the requested phase

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
40. DEFINITION OF ARCHITECTURAL SUCCESS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The backend architecture is successful when:

- Features are modular.
- Business logic is separated from HTTP.
- Database access is centralized.
- Authentication is secure.
- Authorization is server-side.
- Real-time functionality is isolated.
- Redis is used appropriately.
- External integrations are abstracted.
- APIs are versioned.
- Errors are consistent.
- Logging is structured.
- Testing is possible.
- Deployment is reproducible.
- Horizontal scaling is possible.
- The frontend can integrate without major rewrites.

END OF BACKEND ARCHITECTURE SPECIFICATION# Backend Architecture
