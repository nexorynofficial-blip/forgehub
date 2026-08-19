FORGEHUB — BACKEND TECHNICAL REQUIREMENTS DOCUMENT

Version: 1.0
Status: Development Specification

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. SYSTEM OVERVIEW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ForgeHub backend is a production-oriented API and real-time application server powering a social platform for builders, developers, designers, founders, creators, and collaborators.

The backend must integrate with the completed ForgeHub frontend.

The architecture must support:

- REST APIs
- Real-time communication
- Authentication
- Authorization
- PostgreSQL persistence
- Redis caching
- File storage
- Background processing
- AI integrations
- Moderation
- Analytics

The backend must be modular so individual services can evolve without requiring a complete rewrite.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2. TECHNOLOGY STACK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Runtime:

Node.js 22 LTS

Language:

TypeScript

Framework:

Express.js

Database:

PostgreSQL

ORM:

Prisma

Caching:

Redis

Real-time:

Socket.IO

Validation:

Zod

Authentication:

JWT
Refresh Tokens

Password Hashing:

Argon2id preferred
bcrypt acceptable if required by environment constraints

File Storage:

Cloudinary

Logging:

Pino

Testing:

Vitest
Supertest

API Documentation:

OpenAPI / Swagger

Containerization:

Docker
Docker Compose

Package Manager:

npm unless the existing repository specifies another package manager

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
3. ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Use a modular layered architecture.

Recommended structure:

src/
│
├── config/
│
├── controllers/
│
├── services/
│
├── repositories/
│
├── routes/
│
├── middleware/
│
├── validators/
│
├── schemas/
│
├── models/
│
├── types/
│
├── utils/
│
├── lib/
│
├── events/
│
├── sockets/
│
├── jobs/
│
├── integrations/
│
├── modules/
│
├── database/
│
└── app.ts

The implementation may use a feature/module-oriented structure where it produces a cleaner architecture.

Do not blindly follow this structure if a better scalable architecture is identified.

The final architecture must remain understandable to another senior engineer.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
4. FEATURE MODULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The backend should be organized around the following major domains:

auth
users
profiles
projects
posts
comments
follows
communities
messages
notifications
search
achievements
moderation
admin
uploads
ai

Each module should own its relevant:

- Routes
- Controllers
- Services
- Validation
- Types
- Repository logic
- Tests

Shared functionality should remain outside feature modules.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
5. API DESIGN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

All REST APIs must use a versioned API prefix.

Example:

/api/v1

Example endpoints:

POST   /api/v1/auth/register
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh
POST   /api/v1/auth/logout

GET    /api/v1/users/:username
PATCH  /api/v1/users/me

GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/:id
PATCH  /api/v1/projects/:id
DELETE /api/v1/projects/:id

GET    /api/v1/feed
POST   /api/v1/posts

GET    /api/v1/communities
POST   /api/v1/communities

GET    /api/v1/notifications

The exact API contract must be determined after analyzing the existing frontend.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
6. HTTP METHODS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Use standard REST conventions.

GET:

Retrieve resources.

POST:

Create resources or perform actions.

PATCH:

Partially update resources.

PUT:

Use only where complete replacement is appropriate.

DELETE:

Remove resources.

Avoid unnecessary custom endpoints when standard REST semantics are sufficient.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
7. RESPONSE FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Use a consistent API response structure.

Successful response:

{
  "success": true,
  "data": {},
  "message": "Operation completed successfully"
}

Collection response:

{
  "success": true,
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}

Error response:

{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request",
    "details": {}
  }
}

Never expose internal stack traces or sensitive implementation details to clients in production.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
8. PAGINATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Large collections must never be returned without pagination.

Use pagination for:

- Feed
- Comments
- Followers
- Following
- Projects
- Communities
- Messages
- Notifications
- Search
- Admin lists

Cursor-based pagination should be preferred for high-volume or real-time collections.

Offset pagination may be used where appropriate.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
9. DATABASE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PostgreSQL is the primary persistent database.

Prisma is the ORM.

Database design must prioritize:

- Referential integrity
- Appropriate indexes
- Unique constraints
- Foreign keys
- Cascading rules
- Query performance
- Data consistency

Do not create redundant fields unless justified.

Avoid storing derived data when it can safely be calculated.

Denormalization may be introduced only where performance requirements justify it.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
10. DATABASE ENTITIES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Expected entities include:

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

ProjectTag

Tag

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

Message

Conversation

ConversationMember

MessageReaction

Notification

Achievement

UserAchievement

Report

ModerationAction

AuditLog

The final schema must be determined from the complete frontend and PRD analysis.

Do not blindly create every model if analysis shows a better structure.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
11. DATABASE INDEXING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Create indexes for frequently queried fields.

Potential indexes include:

User.username

User.email

Post.authorId

Post.createdAt

Comment.postId

Project.ownerId

Project.createdAt

Community.createdAt

Message.conversationId

Message.createdAt

Notification.userId

Notification.createdAt

Follow.followerId

Follow.followingId

Search-related fields where appropriate

Composite indexes should be used where query patterns justify them.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
12. AUTHENTICATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Authentication must use:

Short-lived JWT access token

Long-lived refresh token

Refresh token rotation

Secure token invalidation

Passwords must never be stored in plaintext.

Use Argon2id or bcrypt.

Authentication endpoints must include:

Registration

Login

Logout

Refresh

Email verification

Password reset

Current user

Session management

2FA architecture

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
13. TOKEN SECURITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Access tokens should be short-lived.

Refresh tokens must:

- Be securely generated
- Be revocable
- Be rotated
- Be associated with a session/device
- Be stored securely

Never expose secrets through API responses.

Environment variables must be used for:

JWT secrets

Database credentials

Redis credentials

Cloudinary credentials

Email credentials

AI API keys

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
14. AUTHORIZATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Implement authorization middleware.

Roles may include:

USER

MODERATOR

ADMIN

SUPER_ADMIN

Resource-level permissions must also be enforced.

Example:

A user may edit their own project.

A project member may have limited project permissions.

A community moderator may moderate community content.

An admin may access administrative functionality.

Never rely solely on frontend authorization.

All sensitive permissions must be verified server-side.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
15. VALIDATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Use Zod for request validation.

Validate:

Body

Query parameters

Path parameters

Headers where necessary

Uploaded files

Never trust client-side validation.

Frontend validation is supplementary.

Backend validation is authoritative.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
16. ERROR HANDLING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Implement a centralized error handling system.

Use structured application errors.

Example categories:

VALIDATION_ERROR

AUTHENTICATION_ERROR

AUTHORIZATION_ERROR

NOT_FOUND

CONFLICT

RATE_LIMITED

DATABASE_ERROR

INTERNAL_ERROR

Never expose sensitive database or infrastructure errors to users.

Log detailed internal errors securely.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
17. SECURITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Implement:

Helmet

CORS

Rate limiting

Request size limits

Input validation

Secure cookies where applicable

Password hashing

JWT protection

Authorization middleware

Brute-force protection

Account lockout/rate limiting where appropriate

Secure headers

Audit logging

File upload validation

Content-type validation

Do not trust filenames or client-provided MIME types.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
18. REDIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Redis should support:

Caching

Rate limiting

Session-related temporary data

Real-time presence

Short-lived verification data where appropriate

Background job infrastructure where required

Do not use Redis as the primary persistent database.

Cache invalidation must be deliberate.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
19. REAL-TIME SYSTEM
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Use Socket.IO.

Primary real-time features:

Messaging

Typing indicators

Presence

Read receipts

Notifications

Potential future real-time project/community updates

Example events:

connection

disconnect

user:online

user:offline

message:send

message:new

message:read

message:typing

message:stop_typing

notification:new

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
20. SOCKET SECURITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Socket connections must be authenticated.

Do not trust client-provided user IDs.

Verify:

User identity

Conversation membership

Community permissions

Message permissions

All socket actions must pass authorization checks.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
21. MESSAGING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Messages must be persisted in PostgreSQL.

Socket.IO provides real-time delivery.

Architecture:

Client

↓

Socket.IO

↓

Authentication

↓

Authorization

↓

Message Service

↓

PostgreSQL

↓

Recipient Socket

Messages should support:

Text

Attachments

Reactions

Editing

Deletion

Read status

Timestamps

Future group conversations

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
22. NOTIFICATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Notifications must be persisted.

Types include:

LIKE

COMMENT

REPLY

FOLLOW

MENTION

PROJECT_INVITE

COMMUNITY_INVITE

MESSAGE

ACHIEVEMENT

MODERATION

Notifications should be delivered through:

REST API

Socket.IO

The notification service must remain independent of individual controllers.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
23. FILE UPLOADS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Use Cloudinary or equivalent external object storage.

The backend should:

Validate files

Validate size

Validate MIME type

Generate secure upload workflows

Store metadata

Return safe URLs

Do not store large files directly in PostgreSQL.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
24. SEARCH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Initial search may use PostgreSQL capabilities.

Search entities:

Users

Projects

Communities

Posts

Tags

The architecture should allow future migration to:

Elasticsearch

OpenSearch

Meilisearch

or another dedicated search engine.

Do not tightly couple application logic to a specific future search provider.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
25. BACKGROUND JOBS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Use background processing for tasks that should not block API requests.

Potential jobs:

Email delivery

Notifications

Image processing

AI processing

Achievement evaluation

Analytics aggregation

Moderation processing

Redis-backed job infrastructure may be used.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
26. EMAIL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Email functionality should support:

Verification emails

Password reset

Security alerts

Project invitations

Community invitations

Future notification emails

Use a provider abstraction so the provider can be changed later.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
27. AI INTEGRATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

AI functionality must use an abstraction layer.

Example:

AIService

Providers:

OpenAI

Anthropic

Google

Local models

The application should not depend directly on one provider throughout the codebase.

AI features may include:

Project summaries

Content moderation

Tag recommendations

Project feedback

Builder recommendations

Collaborator matching

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
28. MODERATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Moderation must support:

Reports

Review queues

Moderation actions

Warnings

Content removal

User suspension

User banning

Appeals architecture

All important moderation actions must generate audit records.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
29. AUDIT LOGGING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Track security-sensitive and administrative actions.

Examples:

Login

Logout

Password change

Role change

User suspension

User ban

Content deletion

Moderation action

Project ownership change

Community ownership change

Audit logs must not be editable by normal users.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
30. LOGGING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Use Pino.

Logs should include:

Timestamp

Request ID

HTTP method

Route

Status code

Duration

User ID where available

Error information

Do not log:

Passwords

JWT secrets

Refresh tokens

Private messages

Sensitive personal information

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
31. API DOCUMENTATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Use OpenAPI.

Document:

Endpoints

Parameters

Request bodies

Responses

Authentication

Errors

Pagination

WebSocket events where practical

Documentation should remain synchronized with implementation.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
32. TESTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Testing must cover:

Authentication

Authorization

Validation

Services

Repositories

API endpoints

Database behavior

Messaging

Socket events

Moderation

Critical security paths

Use:

Vitest

Supertest

Additional socket testing tools where appropriate.

Critical functionality should have integration tests.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
33. ENVIRONMENT MANAGEMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Use environment variables.

Create:

.env.example

Never commit:

.env

Secrets

API keys

Database passwords

JWT secrets

Cloud credentials

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
34. DOCKER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Development environment should support Docker Compose.

Services should include:

Backend

PostgreSQL

Redis

Additional services only when required.

The application should be able to start with a documented command.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
35. HEALTH CHECKS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Implement:

GET /health

The health endpoint should verify application availability.

A deeper readiness endpoint may verify:

PostgreSQL

Redis

Critical dependencies

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
36. API VERSIONING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Use:

/api/v1

Future breaking changes should use:

/api/v2

Avoid breaking existing clients unnecessarily.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
37. FRONTEND INTEGRATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The completed ForgeHub frontend is the primary client.

Before implementing an endpoint:

Inspect the frontend implementation.

Determine:

Expected request

Expected response

Loading state

Error state

Authentication requirement

Pagination

Optimistic updates

Real-time requirements

The backend should adapt to the existing frontend where practical.

If a frontend implementation is clearly architecturally incorrect, document the issue before changing it.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
38. PERFORMANCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Optimize:

Database queries

Prisma includes/selects

Pagination

Caching

Socket connections

API payload size

Serialization

Image delivery

Avoid:

N+1 queries

Unbounded queries

Huge response payloads

Unnecessary database calls

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
39. SCALABILITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The backend should be capable of future horizontal scaling.

Stateless API servers should be preferred.

Shared state should use:

PostgreSQL

Redis

External storage

Socket.IO should use the Redis adapter when multiple backend instances are introduced.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
40. DEVELOPMENT PRINCIPLES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Claude Code must:

Read documentation before coding.

Analyze existing code before modifying it.

Never blindly overwrite working code.

Never duplicate functionality.

Never implement future phases prematurely.

Use strict TypeScript.

Keep business logic out of controllers.

Keep database access out of routes.

Validate all external input.

Test critical functionality.

Document important architectural decisions.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
41. DEFINITION OF DONE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

A backend phase is complete only when:

- Code compiles
- TypeScript errors are resolved
- Relevant tests pass
- Database migrations work where applicable
- API behavior is documented
- Security requirements are respected
- Error handling is implemented
- Existing frontend compatibility is maintained
- No unnecessary future-phase functionality has been implemented

The backend should always remain production-oriented.

END OF BACKEND TRD# Backend TRD
