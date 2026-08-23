import { getConfig } from "../config.js";
import { request } from "./http.js";

const API = "https://backboard.railway.app/graphql/v2";

/**
 * Railway deployments, over its GraphQL API.
 *
 * Only two operations really matter to the swarm: set the environment variables
 * the build needs, and trigger + observe a deploy. Production deploys are gated
 * behind the deploy:production capability, which is not granted by default.
 */
export class Railway {
  readonly name = "railway";

  private get token(): string | undefined {
    return getConfig().RAILWAY_TOKEN;
  }

  available(): boolean {
    return Boolean(this.token && getConfig().RAILWAY_PROJECT_ID);
  }

  unavailableReason(): string | null {
    if (!this.token) return "RAILWAY_TOKEN is not set";
    if (!getConfig().RAILWAY_PROJECT_ID) return "RAILWAY_PROJECT_ID is not set";
    return null;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const result = await request<{ data?: T; errors?: Array<{ message: string }> }>(
      "railway",
      API,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}` },
        body: { query, variables },
      },
    );
    if (result.errors?.length) {
      throw new Error(`railway graphql: ${result.errors.map((e) => e.message).join("; ")}`);
    }
    return result.data as T;
  }

  /** Read-only preflight: whoami plus the configured project. */
  async verify(): Promise<string> {
    const data = await this.graphql<{ me: { email?: string; name?: string; id: string } }>(
      `query { me { id email name } }`,
      {},
    );
    const who = data.me.email ?? data.me.name ?? data.me.id;
    const project = await this.graphql<{ project: { name: string } }>(
      `query Project($id: String!) { project(id: $id) { name } }`,
      { id: getConfig().RAILWAY_PROJECT_ID },
    );
    const env = getConfig().RAILWAY_ENVIRONMENT_ID
      ? "environment set"
      : "RAILWAY_ENVIRONMENT_ID not set (required to deploy)";
    return `${who} -> project ${project.project.name}, ${env}`;
  }

  async setVariables(
    serviceId: string,
    variables: Record<string, string>,
  ): Promise<number> {
    const cfg = getConfig();
    const mutation = `
      mutation Upsert($input: VariableCollectionUpsertInput!) {
        variableCollectionUpsert(input: $input)
      }`;
    await this.graphql(mutation, {
      input: {
        projectId: cfg.RAILWAY_PROJECT_ID,
        environmentId: cfg.RAILWAY_ENVIRONMENT_ID,
        serviceId,
        variables,
      },
    });
    return Object.keys(variables).length;
  }

  async deploy(serviceId: string, commitSha?: string): Promise<{ id: string }> {
    const cfg = getConfig();
    const mutation = `
      mutation Redeploy($serviceId: String!, $environmentId: String!, $commitSha: String) {
        serviceInstanceDeploy(
          serviceId: $serviceId
          environmentId: $environmentId
          commitSha: $commitSha
        )
      }`;
    await this.graphql(mutation, {
      serviceId,
      environmentId: cfg.RAILWAY_ENVIRONMENT_ID,
      commitSha: commitSha ?? null,
    });
    return { id: serviceId };
  }

  async latestDeployment(serviceId: string): Promise<{ id: string; status: string } | null> {
    const query = `
      query Deployments($serviceId: String!, $environmentId: String!) {
        deployments(
          first: 1
          input: { serviceId: $serviceId, environmentId: $environmentId }
        ) { edges { node { id status } } }
      }`;
    const data = await this.graphql<{
      deployments: { edges: Array<{ node: { id: string; status: string } }> };
    }>(query, {
      serviceId,
      environmentId: getConfig().RAILWAY_ENVIRONMENT_ID,
    });
    return data.deployments.edges[0]?.node ?? null;
  }
}
