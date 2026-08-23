import { Clerk } from "./clerk.js";
import { GitHub } from "./github.js";
import { Neon } from "./neon.js";
import { Railway } from "./railway.js";
import { Resend } from "./resend.js";

export { Clerk } from "./clerk.js";
export { GitHub, type RepoRef } from "./github.js";
export { IntegrationError, request } from "./http.js";
export { Neon, type NeonBranch } from "./neon.js";
export { Railway } from "./railway.js";
export { Resend } from "./resend.js";

export interface Integrations {
  github: GitHub;
  neon: Neon;
  railway: Railway;
  clerk: Clerk;
  resend: Resend;
}

export function buildIntegrations(): Integrations {
  return {
    github: new GitHub(),
    neon: new Neon(),
    railway: new Railway(),
    clerk: new Clerk(),
    resend: new Resend(),
  };
}

/** What is actually wired up right now, for the plan prompt and the run report. */
export function integrationStatus(integrations: Integrations): Record<string, string> {
  const status: Record<string, string> = {};
  for (const service of Object.values(integrations)) {
    status[service.name] = service.available()
      ? "available"
      : `unavailable (${service.unavailableReason()})`;
  }
  return status;
}
