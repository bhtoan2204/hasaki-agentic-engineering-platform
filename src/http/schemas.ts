import { z } from "zod";

/**
 * Request body schemas for the endpoints that handle credentials, accounts, uploads and workflow definitions. Objects
 * are loose (unknown fields pass through untouched) so a client that sends extra fields keeps working; what is enforced
 * is the type and size of the fields each handler reads. Missing text fields default to "" exactly like the former
 * `String(body.x ?? "")`, so the domain functions keep producing their own "… is required" messages.
 */
const text = (max: number) => z.string().max(max).default("");
const optionalText = (max: number) => z.string().max(max).optional();

export const LoginBody = z.looseObject({ username: text(200), password: text(1024) });
export const PasswordBody = z.looseObject({ password: text(1024) });
export const CreateUserBody = z.looseObject({
  username: text(200),
  password: text(1024),
  role: z.enum(["admin", "member"]).default("member"),
});
export const SetActiveBody = z.looseObject({ active: z.boolean().default(true) });

/** A pasted personal access token or session cookie. */
export const TokenBody = z.looseObject({ token: text(16 * 1024) });
export const CookieBody = z.looseObject({ cookie: text(64 * 1024) });
export const BitbucketBody = z.looseObject({
  user: optionalText(256),
  token: optionalText(16 * 1024),
  workspace: optionalText(256),
  reviewers: z.union([z.string().max(4096), z.array(z.string().max(256)).max(100)]).optional(),
});
export const GithubBody = z.looseObject({ token: optionalText(16 * 1024) });
export const GitlabBody = z.looseObject({
  host: optionalText(512),
  base_url: optionalText(512),
  token: optionalText(16 * 1024),
});
export const GitlabSshKeyBody = z.looseObject({
  host: optionalText(512),
  base_url: optionalText(512),
  ssh_key: optionalText(16 * 1024),
});

/** Chat attachment: base64 bytes (size is checked by the handler before decoding) and an optional file name. */
export const AttachmentBody = z.looseObject({
  data: z.string().optional(),
  filename: optionalText(512),
});
/** Evidence for the report step: base64 file or a note. */
export const EvidenceBody = z.looseObject({
  requirement_id: z.string().max(32).nullable().optional(),
  name: optionalText(512),
  mime: optionalText(128),
  data_base64: z.string().optional(),
  note: optionalText(20_000),
  by: optionalText(256),
});

/** Workflow definition envelope; the spec itself is validated by validateSpec (src/workflow/types.ts). */
export const CreateWorkflowBody = z.looseObject({
  key: text(128),
  spec: z.unknown().optional(),
  publish: z.boolean().optional(),
  change_note: optionalText(2000),
  shared: z.boolean().optional(),
  is_template: z.boolean().optional(),
});
export const PublishWorkflowBody = z.looseObject({ change_note: text(2000) });
